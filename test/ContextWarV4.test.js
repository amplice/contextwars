const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("ContextWarV4", function () {
  let war, usdc;
  let owner, oracle, alice, bob, charlie;
  const MIN_BID = 250_000n; // 0.25 USDC
  const ROUND_DURATION = 3600; // 1 hour
  const RAKE_BPS = 0; // 0% for testing
  const SPLIT_BPS = 5000; // 50/50

  async function deploy() {
    [owner, oracle, alice, bob, charlie] = await ethers.getSigners();

    // Deploy mock USDC (6 decimals)
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Mint USDC to players
    const amount = 1000_000_000n; // 1000 USDC
    await usdc.mint(owner.address, amount);
    await usdc.mint(alice.address, amount);
    await usdc.mint(bob.address, amount);
    await usdc.mint(charlie.address, amount);

    // Deploy ContextWarV4
    const CW = await ethers.getContractFactory("ContextWarV4");
    war = await CW.deploy(
      await usdc.getAddress(),
      oracle.address,
      MIN_BID,
      ROUND_DURATION,
      RAKE_BPS,
      SPLIT_BPS
    );

    // Approve USDC for all players
    const warAddr = await war.getAddress();
    await usdc.connect(owner).approve(warAddr, ethers.MaxUint256);
    await usdc.connect(alice).approve(warAddr, ethers.MaxUint256);
    await usdc.connect(bob).approve(warAddr, ethers.MaxUint256);
    await usdc.connect(charlie).approve(warAddr, ethers.MaxUint256);

    return { war, usdc, owner, oracle, alice, bob, charlie };
  }

  describe("Deployment", function () {
    it("Should set constructor params correctly", async function () {
      const { war } = await deploy();
      expect(await war.minBid()).to.equal(MIN_BID);
      expect(await war.roundDuration()).to.equal(ROUND_DURATION);
      expect(await war.rakeBps()).to.equal(RAKE_BPS);
      expect(await war.splitBps()).to.equal(SPLIT_BPS);
      expect(await war.maxSlotsPerPlayer()).to.equal(6);
      expect(await war.oracleAddress()).to.equal(oracle.address);
    });
  });

  describe("Round Lifecycle", function () {
    it("Should create a pending round (no timer)", async function () {
      const { war } = await deploy();
      const seed = 100_000_000n; // 100 USDC
      await war.startRound(seed);

      const info = await war.getRoundInfo();
      expect(info.id).to.equal(1);
      expect(info.startedAt).to.equal(0); // pending
      expect(info.endTime).to.equal(0);
      expect(info.prizePool).to.equal(seed);
      expect(info.pending).to.be.true;
      expect(info.active).to.be.false;
    });

    it("Should start clock on first bid", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      await war.connect(alice).bid(0, "hello", MIN_BID);

      const info = await war.getRoundInfo();
      expect(info.startedAt).to.be.greaterThan(0);
      expect(info.endTime).to.be.greaterThan(0);
      expect(info.pending).to.be.false;
      expect(info.active).to.be.true;
    });

    it("Should reject bids after round ends", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "hello", MIN_BID);

      await time.increase(ROUND_DURATION + 1);

      await expect(
        war.connect(alice).bid(1, "world", MIN_BID)
      ).to.be.revertedWithCustomError(war, "RoundNotActive");
    });

    it("Should not allow resolution of pending round", async function () {
      const { war, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);

      await expect(
        war.connect(oracleSigner).resolveRound([], [], [])
      ).to.be.revertedWithCustomError(war, "RoundNotStarted");
    });
  });

  describe("Bid Split", function () {
    it("Should split bids 50/50 between current and next pot", async function () {
      const { war, alice } = await deploy();
      const seed = 100_000_000n;
      await war.startRound(seed);

      const bidAmount = 1_000_000n; // 1 USDC
      await war.connect(alice).bid(0, "test", bidAmount);

      const info = await war.getRoundInfo();
      // Current pot = seed + 50% of bid
      expect(info.prizePool).to.equal(seed + bidAmount / 2n);
      // Next pot = 50% of bid
      expect(await war.nextPrizePool()).to.equal(bidAmount / 2n);
    });

    it("Should handle odd amounts (rounding)", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      // Bid an odd amount
      const bidAmount = 333_333n;
      await war.connect(alice).bid(0, "odd", bidAmount);

      const toCurrentPot = (bidAmount * 5000n) / 10000n; // 166666
      const toNextPot = bidAmount - toCurrentPot; // 166667
      expect(await war.nextPrizePool()).to.equal(toNextPot);
    });

    it("Should respect custom split ratio", async function () {
      const { war, alice } = await deploy();
      // Set 70% to current, 30% to next
      await war.setSplit(7000);
      await war.startRound(100_000_000n);

      const bidAmount = 1_000_000n;
      await war.connect(alice).bid(0, "split", bidAmount);

      const toCurrent = (bidAmount * 7000n) / 10000n;
      expect(await war.nextPrizePool()).to.equal(bidAmount - toCurrent);
    });
  });

  describe("Slot Cap", function () {
    it("Should enforce max 6 slots per player", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      // Bid on 6 slots — should work
      for (let i = 0; i < 6; i++) {
        await war.connect(alice).bid(i, `word${i}`, MIN_BID);
      }

      // 7th slot should fail
      await expect(
        war.connect(alice).bid(6, "toomany", MIN_BID)
      ).to.be.revertedWithCustomError(war, "SlotCapReached");
    });

    it("Should free slot when outbid", async function () {
      const { war, alice, bob } = await deploy();
      await war.startRound(100_000_000n);

      // Alice takes 6 slots
      for (let i = 0; i < 6; i++) {
        await war.connect(alice).bid(i, `alice${i}`, MIN_BID);
      }

      // Bob outbids Alice on slot 0
      await war.connect(bob).bid(0, "stolen", MIN_BID * 2n);

      // Alice should now have 5 slots and can take slot 6
      await war.connect(alice).bid(6, "free", MIN_BID);
    });

    it("Should allow re-bidding on own slot without cap issue", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      // Take 6 slots
      for (let i = 0; i < 6; i++) {
        await war.connect(alice).bid(i, `word${i}`, MIN_BID);
      }

      // Re-bid on own slot 0 — should work (not a new slot)
      await war.connect(alice).bid(0, "updated", MIN_BID);
    });

    it("Should be toggleable to 12 (disabled)", async function () {
      const { war, alice } = await deploy();
      await war.setMaxSlotsPerPlayer(12);
      await war.startRound(100_000_000n);

      // Should be able to take all 12
      for (let i = 0; i < 12; i++) {
        await war.connect(alice).bid(i, `all${i}`, MIN_BID);
      }
    });
  });

  describe("Anti-Snipe", function () {
    it("Should extend round by 1 min if bid in last minute", async function () {
      const { war, alice, bob } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "start", MIN_BID);

      const info1 = await war.getRoundInfo();
      const originalEnd = info1.endTime;

      // Move to 30 seconds before end
      await time.increaseTo(originalEnd - 30n);

      // Bid in last minute — should extend
      await war.connect(bob).bid(1, "snipe", MIN_BID);

      const info2 = await war.getRoundInfo();
      expect(info2.endTime).to.equal(originalEnd + 60n);
    });

    it("Should allow multiple extensions", async function () {
      const { war, alice, bob } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "start", MIN_BID);

      const info1 = await war.getRoundInfo();

      // Move to last minute
      await time.increaseTo(info1.endTime - 30n);
      await war.connect(bob).bid(1, "ext1", MIN_BID);

      const info2 = await war.getRoundInfo();
      // Move to last minute again
      await time.increaseTo(info2.endTime - 30n);
      await war.connect(alice).bid(2, "ext2", MIN_BID);

      const info3 = await war.getRoundInfo();
      expect(info3.endTime).to.equal(info1.endTime + 120n);
    });
  });

  describe("Word Validation", function () {
    it("Should reject words with spaces", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      await expect(
        war.connect(alice).bid(0, "two words", MIN_BID)
      ).to.be.revertedWithCustomError(war, "WordContainsSpace");
    });

    it("Should allow underscores", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "under_score", MIN_BID);
      const slot = await war.getSlot(0);
      expect(slot.word).to.equal("under_score");
    });

    it("Should enforce 22 char max", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      // 22 chars — should work
      await war.connect(alice).bid(0, "a".repeat(22), MIN_BID);

      // 23 chars — should fail
      await expect(
        war.connect(alice).bid(1, "a".repeat(23), MIN_BID)
      ).to.be.revertedWithCustomError(war, "WordTooLong");
    });

    it("Should reject empty words", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      await expect(
        war.connect(alice).bid(0, "", MIN_BID)
      ).to.be.revertedWithCustomError(war, "WordEmpty");
    });
  });

  describe("Funding", function () {
    it("Should allow anyone to fund current round", async function () {
      const { war, alice } = await deploy();
      await war.startRound(50_000_000n);

      await war.connect(alice).fund(25_000_000n);

      const info = await war.getRoundInfo();
      expect(info.prizePool).to.equal(75_000_000n);
    });

    it("Should reject funding after round ends", async function () {
      const { war, alice } = await deploy();
      await war.startRound(50_000_000n);
      await war.connect(alice).bid(0, "start", MIN_BID);
      await time.increase(ROUND_DURATION + 1);

      await expect(
        war.connect(alice).fund(10_000_000n)
      ).to.be.revertedWithCustomError(war, "RoundEnded");
    });

    it("Should allow funding a pending round", async function () {
      const { war, alice } = await deploy();
      await war.startRound(50_000_000n);

      // No bids yet — round is pending
      await war.connect(alice).fund(50_000_000n);
      const info = await war.getRoundInfo();
      expect(info.prizePool).to.equal(100_000_000n);
      expect(info.pending).to.be.true;
    });
  });

  describe("Oracle Resolution", function () {
    it("Should distribute USDC correctly", async function () {
      const { war, usdc, alice, bob, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);

      await war.connect(alice).bid(0, "alice", MIN_BID);
      await war.connect(bob).bid(1, "bob", MIN_BID);

      await time.increase(ROUND_DURATION + 1);

      // Prize = 100M + 50% of (250K + 250K) = 100M + 250K = 100_250_000
      const info = await war.getRoundInfo();
      const prize = info.prizePool;

      const aliceBefore = await usdc.balanceOf(alice.address);
      await war.connect(oracleSigner).resolveRound(
        [alice.address, bob.address],
        [prize / 2n, prize - prize / 2n],
        []
      );
      const aliceAfter = await usdc.balanceOf(alice.address);
      expect(aliceAfter - aliceBefore).to.equal(prize / 2n);
    });

    it("Should allow oracle to send to non-players", async function () {
      const { war, usdc, alice, bob, charlie, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);

      await war.connect(alice).bid(0, "sendToCharlie", MIN_BID);
      await war.connect(bob).bid(1, "yes", MIN_BID);

      await time.increase(ROUND_DURATION + 1);

      const info = await war.getRoundInfo();
      const charlieBefore = await usdc.balanceOf(charlie.address);

      // Charlie didn't play but oracle sends to them
      await war.connect(oracleSigner).resolveRound(
        [charlie.address],
        [info.prizePool],
        []
      );

      const charlieAfter = await usdc.balanceOf(charlie.address);
      expect(charlieAfter - charlieBefore).to.equal(info.prizePool);
    });

    it("Should reject with < 2 players", async function () {
      const { war, alice, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "solo", MIN_BID);
      await time.increase(ROUND_DURATION + 1);

      await expect(
        war.connect(oracleSigner).resolveRound([alice.address], [100_125_000n], [])
      ).to.be.revertedWithCustomError(war, "NeedMorePlayers");
    });

    it("Should reject mismatched allocation", async function () {
      const { war, alice, bob, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "a", MIN_BID);
      await war.connect(bob).bid(1, "b", MIN_BID);
      await time.increase(ROUND_DURATION + 1);

      await expect(
        war.connect(oracleSigner).resolveRound(
          [alice.address],
          [1n], // wrong total
          []
        )
      ).to.be.revertedWithCustomError(war, "AllocationMismatch");
    });
  });

  describe("Solo Round Refund", function () {
    it("Should refund solo player and carry pot forward", async function () {
      const { war, usdc, alice } = await deploy();
      const seed = 100_000_000n;
      await war.startRound(seed);

      await war.connect(alice).bid(0, "alone", MIN_BID);
      const aliceBalBefore = await usdc.balanceOf(alice.address);

      await time.increase(ROUND_DURATION + 1);
      await war.refundSoloRound();

      // Alice gets full bid back
      const aliceBalAfter = await usdc.balanceOf(alice.address);
      expect(aliceBalAfter - aliceBalBefore).to.equal(MIN_BID);

      // Seed carries forward: nextPrizePool = old_next + prizePool - spent = seed
      // But auto-advance consumes nextPrizePool into the new round's prizePool
      const info = await war.getRoundInfo();
      expect(info.id).to.equal(2); // new round auto-created
      expect(info.prizePool).to.equal(seed); // seed carried forward
      expect(info.pending).to.be.true;
    });

    it("Should reject if multiple players", async function () {
      const { war, alice, bob } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "a", MIN_BID);
      await war.connect(bob).bid(1, "b", MIN_BID);
      await time.increase(ROUND_DURATION + 1);

      await expect(
        war.refundSoloRound()
      ).to.be.revertedWithCustomError(war, "HasMultiplePlayers");
    });
  });

  describe("Auto-Advance", function () {
    it("Should auto-create next round after resolution", async function () {
      const { war, alice, bob, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);

      await war.connect(alice).bid(0, "a", 2_000_000n); // 2 USDC
      await war.connect(bob).bid(1, "b", 2_000_000n);

      await time.increase(ROUND_DURATION + 1);

      const info1 = await war.getRoundInfo();
      await war.connect(oracleSigner).resolveRound(
        [alice.address],
        [info1.prizePool],
        []
      );

      // Next round should auto-start if nextPrizePool >= 1 USDC
      const info2 = await war.getRoundInfo();
      expect(info2.id).to.equal(2);
      expect(info2.pending).to.be.true;
      expect(info2.prizePool).to.be.greaterThan(0);
    });

    it("Should NOT auto-create if nextPrizePool < 1 USDC", async function () {
      const { war, alice, bob, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);

      // Tiny bids — 50% of 0.25 = 0.125 each to next pot
      await war.connect(alice).bid(0, "a", MIN_BID);
      await war.connect(bob).bid(1, "b", MIN_BID);

      await time.increase(ROUND_DURATION + 1);

      const info1 = await war.getRoundInfo();
      await war.connect(oracleSigner).resolveRound(
        [alice.address],
        [info1.prizePool],
        []
      );

      // nextPrizePool = 250K (0.25 USDC) — below 1 USDC threshold
      const info2 = await war.getRoundInfo();
      expect(info2.id).to.equal(1); // still round 1, no new round created
      expect(info2.resolved).to.be.true;
    });
  });

  describe("ETH Support", function () {
    it("Should accept ETH and add to current round", async function () {
      const { war, alice } = await deploy();
      await war.startRound(100_000_000n);

      await alice.sendTransaction({
        to: await war.getAddress(),
        value: ethers.parseEther("1.0"),
      });

      const info = await war.getRoundInfo();
      expect(info.ethPrizePool).to.equal(ethers.parseEther("1.0"));
    });

    it("Should hold ETH as pending if no round", async function () {
      const { war, alice } = await deploy();

      await alice.sendTransaction({
        to: await war.getAddress(),
        value: ethers.parseEther("0.5"),
      });

      expect(await war.pendingEth()).to.equal(ethers.parseEther("0.5"));
    });

    it("Should distribute ETH during resolution", async function () {
      const { war, alice, bob, oracle: oracleSigner } = await deploy();
      await war.startRound(100_000_000n);

      await alice.sendTransaction({
        to: await war.getAddress(),
        value: ethers.parseEther("1.0"),
      });

      await war.connect(alice).bid(0, "a", MIN_BID);
      await war.connect(bob).bid(1, "b", MIN_BID);
      await time.increase(ROUND_DURATION + 1);

      const info = await war.getRoundInfo();
      const aliceEthBefore = await ethers.provider.getBalance(alice.address);

      await war.connect(oracleSigner).resolveRound(
        [alice.address, bob.address],
        [info.prizePool / 2n, info.prizePool - info.prizePool / 2n],
        [ethers.parseEther("0.7"), ethers.parseEther("0.3")]
      );

      const aliceEthAfter = await ethers.provider.getBalance(alice.address);
      expect(aliceEthAfter - aliceEthBefore).to.equal(ethers.parseEther("0.7"));
    });
  });

  describe("Emergency Resolution", function () {
    it("Should distribute proportionally after timeout", async function () {
      const { war, usdc, alice, bob } = await deploy();
      await war.startRound(100_000_000n);

      await war.connect(alice).bid(0, "a", 3_000_000n); // 3 USDC
      await war.connect(bob).bid(1, "b", 1_000_000n); // 1 USDC

      await time.increase(ROUND_DURATION + 86401); // 24h + 1s

      const info = await war.getRoundInfo();
      const aliceBefore = await usdc.balanceOf(alice.address);
      const bobBefore = await usdc.balanceOf(bob.address);

      await war.emergencyResolve();

      const aliceAfter = await usdc.balanceOf(alice.address);
      const bobAfter = await usdc.balanceOf(bob.address);

      // Alice spent 3x more than Bob, should get ~75% of prize
      expect(aliceAfter - aliceBefore).to.be.greaterThan(bobAfter - bobBefore);
    });

    it("Should reject before timeout", async function () {
      const { war, alice, bob } = await deploy();
      await war.startRound(100_000_000n);
      await war.connect(alice).bid(0, "a", MIN_BID);
      await war.connect(bob).bid(1, "b", MIN_BID);
      await time.increase(ROUND_DURATION + 1);

      await expect(
        war.emergencyResolve()
      ).to.be.revertedWithCustomError(war, "EmergencyNotReady");
    });
  });

  describe("Rescue Functions", function () {
    it("Should rescue random ERC20 tokens", async function () {
      const { war, owner } = await deploy();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const randomToken = await MockERC20.deploy("Random", "RND", 18);

      await randomToken.mint(await war.getAddress(), ethers.parseEther("100"));
      await war.rescueToken(await randomToken.getAddress());

      expect(await randomToken.balanceOf(owner.address)).to.equal(ethers.parseEther("100"));
    });

    it("Should not allow rescuing USDC", async function () {
      const { war } = await deploy();
      await expect(
        war.rescueToken(await usdc.getAddress())
      ).to.be.revertedWith("Use withdrawRake for USDC");
    });
  });

  describe("View Functions", function () {
    it("Should return correct buffer text", async function () {
      const { war, alice, bob } = await deploy();
      await war.startRound(100_000_000n);

      await war.connect(alice).bid(0, "hello", MIN_BID);
      await war.connect(bob).bid(1, "world", MIN_BID);

      const buffer = await war.getBufferAsText();
      expect(buffer).to.equal("hello world");
    });

    it("Should return round info with correct states", async function () {
      const { war, alice, bob, oracle: oracleSigner } = await deploy();

      // No round
      let info = await war.getRoundInfo();
      expect(info.id).to.equal(0);

      // Pending
      await war.startRound(100_000_000n);
      info = await war.getRoundInfo();
      expect(info.pending).to.be.true;
      expect(info.active).to.be.false;

      // Active
      await war.connect(alice).bid(0, "go", MIN_BID);
      info = await war.getRoundInfo();
      expect(info.pending).to.be.false;
      expect(info.active).to.be.true;

      // Ended
      await war.connect(bob).bid(1, "end", MIN_BID);
      await time.increase(ROUND_DURATION + 1);
      info = await war.getRoundInfo();
      expect(info.active).to.be.false;
      expect(info.resolved).to.be.false;

      // Resolved
      await war.connect(oracleSigner).resolveRound(
        [alice.address],
        [info.prizePool],
        []
      );
      info = await war.getRoundInfo();
      // If auto-advanced, this is round 2
    });
  });
});
