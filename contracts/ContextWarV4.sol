// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title Context War v4
 * @notice Competitive prompt injection with real money.
 *         12 word slots, 22 chars max. Agents bid USDC to control words.
 *         Cumulative bidding — highest total spend per slot wins.
 *         Oracle (fresh Claude instance) reads the buffer and distributes the prize.
 *
 *  v4 changes from v3:
 *   - Bid split: configurable % to current pot vs next pot
 *   - Auto-start: rounds auto-create after resolve, clock starts on first bid
 *   - fund(): anyone can seed the current round's prize pool
 *   - 22 char slot limit (down from 32)
 *   - Spaces only blocked (underscores + unicode allowed)
 *   - Min 2 players to resolve (solo player = refund + carry forward)
 *   - Slot ownership cap (toggleable, default 6)
 *   - ETH support (receive + distribute)
 *   - Anti-snipe: 1-min extension on bids in last minute
 *   - Oracle can send to any address (not just players)
 *   - Round history events with full allocation details
 */
contract ContextWarV4 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ─── Constants ───────────────────────────────────────────

    uint256 public constant NUM_SLOTS = 12;
    uint256 public constant MAX_WORD_LENGTH = 22;
    uint256 public constant MAX_RAKE_BPS = 2000;       // 20% max
    uint256 public constant EMERGENCY_TIMEOUT = 24 hours;
    uint256 public constant ANTI_SNIPE_WINDOW = 60;     // 1 minute
    uint256 public constant ANTI_SNIPE_EXTENSION = 60;  // 1 minute
    uint256 public constant MIN_AUTO_START = 1_000_000; // 1 USDC (6 decimals)

    // ─── Structs ─────────────────────────────────────────────

    struct WordSlot {
        string word;
        address owner;
        uint256 highestTotal;
    }

    struct Round {
        uint256 id;
        uint256 createdAt;      // when round was created (resolve or manual start)
        uint256 startedAt;      // when first bid landed (0 = pending, no timer)
        uint256 endTime;        // startedAt + roundDuration (0 = pending)
        uint256 prizePool;      // USDC prize
        uint256 ethPrizePool;   // ETH prize
        bool resolved;
    }

    // ─── State ───────────────────────────────────────────────

    IERC20 public immutable usdc;

    uint256 public minBid;
    address public oracleAddress;
    uint256 public roundDuration;
    uint256 public rakeBps;
    uint256 public splitBps;            // bid split: bps to current pot (remainder → next)
    uint256 public maxSlotsPerPlayer;   // slot cap per player (set to NUM_SLOTS to disable)
    uint256 public accumulatedRake;
    uint256 public nextPrizePool;       // USDC accumulating for next round
    uint256 public pendingEth;          // ETH waiting for a round to attach to

    Round public currentRound;
    WordSlot[12] public slots;          // NUM_SLOTS, but Solidity needs literal for fixed array

    // Per-round mappings
    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public cumulativeBids;
    mapping(uint256 => mapping(address => uint256)) public totalSpent;
    mapping(uint256 => mapping(address => uint256)) public playerSlotCount;
    mapping(uint256 => address[]) private _roundPlayers;
    mapping(uint256 => mapping(address => bool)) private _isPlayer;

    // ETH pull-pattern for failed transfers
    mapping(address => uint256) public unclaimedEth;

    // ─── Events ──────────────────────────────────────────────

    event RoundCreated(uint256 indexed roundId, uint256 prizePool, uint256 ethPrizePool, address creator);
    event RoundStarted(uint256 indexed roundId, uint256 startTime, uint256 endTime);
    event RoundExtended(uint256 indexed roundId, uint256 newEndTime);
    event RoundResolved(uint256 indexed roundId, string finalBuffer, address[] winners, uint256[] usdcAmounts, uint256[] ethAmounts);
    event SoloRoundRefunded(uint256 indexed roundId, address player, uint256 refundAmount);
    event WordSet(uint256 indexed roundId, uint256 indexed slot, string word, address indexed owner, uint256 cumulative);
    event BidPlaced(uint256 indexed roundId, uint256 indexed slot, address indexed bidder, uint256 amount, uint256 cumulative);
    event Funded(address indexed funder, uint256 amount, uint256 indexed roundId);
    event EthFunded(address indexed funder, uint256 amount, uint256 indexed roundId);
    event EthReceived(address indexed sender, uint256 amount);
    event EthClaimed(address indexed claimer, uint256 amount);
    event EmergencyResolved(uint256 indexed roundId);
    event RakeUpdated(uint256 oldBps, uint256 newBps);
    event SplitUpdated(uint256 oldBps, uint256 newBps);
    event DurationUpdated(uint256 oldDuration, uint256 newDuration);
    event OracleUpdated(address oldOracle, address newOracle);
    event MinBidUpdated(uint256 oldMinBid, uint256 newMinBid);
    event SlotCapUpdated(uint256 oldCap, uint256 newCap);
    event RakeWithdrawn(uint256 amount);

    // ─── Errors ──────────────────────────────────────────────

    error NoActiveRound();
    error RoundNotActive();
    error RoundStillActive();
    error RoundAlreadyResolved();
    error PreviousRoundNotResolved();
    error RoundNotStarted();
    error RoundEnded();
    error InvalidSlot();
    error BidTooLow();
    error WordTooLong();
    error WordEmpty();
    error WordContainsSpace();
    error SlotCapReached();
    error NotOracle();
    error AllocationMismatch();
    error RakeTooHigh();
    error SplitTooHigh();
    error EmptyPrizePool();
    error EmergencyNotReady();
    error NeedMorePlayers();
    error HasMultiplePlayers();
    error NothingToClaim();
    error InvalidSlotCap();

    // ─── Modifiers ───────────────────────────────────────────

    modifier onlyOracle() {
        if (msg.sender != oracleAddress) revert NotOracle();
        _;
    }

    /// @dev Round must exist, not resolved, and either pending or timer still running
    modifier roundOpen() {
        if (currentRound.id == 0) revert NoActiveRound();
        if (currentRound.resolved) revert RoundAlreadyResolved();
        if (currentRound.startedAt > 0 && block.timestamp >= currentRound.endTime) {
            revert RoundNotActive();
        }
        _;
    }

    // ─── Constructor ─────────────────────────────────────────

    constructor(
        address _usdc,
        address _oracle,
        uint256 _minBid,
        uint256 _roundDuration,
        uint256 _rakeBps,
        uint256 _splitBps
    ) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        oracleAddress = _oracle;
        minBid = _minBid;
        roundDuration = _roundDuration;
        if (_rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        if (_splitBps > 10000) revert SplitTooHigh();
        rakeBps = _rakeBps;
        splitBps = _splitBps;
        maxSlotsPerPlayer = 6;
    }

    // ─── Admin ───────────────────────────────────────────────

    function setOracle(address _oracle) external onlyOwner {
        emit OracleUpdated(oracleAddress, _oracle);
        oracleAddress = _oracle;
    }

    function setMinBid(uint256 _minBid) external onlyOwner {
        emit MinBidUpdated(minBid, _minBid);
        minBid = _minBid;
    }

    function setRoundDuration(uint256 _duration) external onlyOwner {
        emit DurationUpdated(roundDuration, _duration);
        roundDuration = _duration;
    }

    function setRake(uint256 _rakeBps) external onlyOwner {
        if (_rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        emit RakeUpdated(rakeBps, _rakeBps);
        rakeBps = _rakeBps;
    }

    function setSplit(uint256 _splitBps) external onlyOwner {
        if (_splitBps > 10000) revert SplitTooHigh();
        emit SplitUpdated(splitBps, _splitBps);
        splitBps = _splitBps;
    }

    function setMaxSlotsPerPlayer(uint256 _cap) external onlyOwner {
        if (_cap == 0 || _cap > NUM_SLOTS) revert InvalidSlotCap();
        emit SlotCapUpdated(maxSlotsPerPlayer, _cap);
        maxSlotsPerPlayer = _cap;
    }

    function withdrawRake() external onlyOwner {
        uint256 amount = accumulatedRake;
        accumulatedRake = 0;
        usdc.safeTransfer(owner(), amount);
        emit RakeWithdrawn(amount);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Round Management ────────────────────────────────────

    /**
     * @notice Create a new round manually. Used for the first round or manual restarts.
     *         Round starts in PENDING state — timer begins on first bid.
     * @param topUp Optional USDC to add to the prize pool.
     */
    function startRound(uint256 topUp) external whenNotPaused {
        if (currentRound.id > 0 && !currentRound.resolved) {
            revert PreviousRoundNotResolved();
        }

        if (topUp > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), topUp);
        }

        uint256 prize = nextPrizePool + topUp;
        if (prize == 0) revert EmptyPrizePool();
        nextPrizePool = 0;

        _createRound(prize, pendingEth, msg.sender);
        pendingEth = 0;
    }

    /**
     * @notice Anyone can add USDC to the current round's prize pool.
     *         Only works on pending or active rounds (not ended/resolved).
     */
    function fund(uint256 amount) external whenNotPaused nonReentrant {
        if (currentRound.id == 0 || currentRound.resolved) revert NoActiveRound();
        if (currentRound.startedAt > 0 && block.timestamp >= currentRound.endTime) {
            revert RoundEnded();
        }
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        currentRound.prizePool += amount;
        emit Funded(msg.sender, amount, currentRound.id);
    }

    /// @notice Accept ETH — goes to current round or pending pool
    receive() external payable {
        if (currentRound.id > 0 && !currentRound.resolved) {
            currentRound.ethPrizePool += msg.value;
            emit EthFunded(msg.sender, msg.value, currentRound.id);
        } else {
            pendingEth += msg.value;
            emit EthReceived(msg.sender, msg.value);
        }
    }

    // ─── Bidding ─────────────────────────────────────────────

    function bid(uint256 slotIndex, string calldata word, uint256 amount)
        external
        roundOpen
        whenNotPaused
        nonReentrant
    {
        if (slotIndex >= NUM_SLOTS) revert InvalidSlot();
        if (amount < minBid) revert BidTooLow();

        bytes memory wordBytes = bytes(word);
        if (wordBytes.length == 0) revert WordEmpty();
        if (wordBytes.length > MAX_WORD_LENGTH) revert WordTooLong();
        _validateWord(wordBytes);

        uint256 roundId = currentRound.id;

        // ── Start clock on first bid ──
        if (currentRound.startedAt == 0) {
            currentRound.startedAt = block.timestamp;
            currentRound.endTime = block.timestamp + roundDuration;
            emit RoundStarted(roundId, block.timestamp, currentRound.endTime);
        }

        // ── Anti-snipe: extend if bid in last minute ──
        if (currentRound.endTime - block.timestamp <= ANTI_SNIPE_WINDOW) {
            currentRound.endTime += ANTI_SNIPE_EXTENSION;
            emit RoundExtended(roundId, currentRound.endTime);
        }

        // ── Update cumulative bids ──
        cumulativeBids[roundId][slotIndex][msg.sender] += amount;
        uint256 newCumulative = cumulativeBids[roundId][slotIndex][msg.sender];
        totalSpent[roundId][msg.sender] += amount;

        // ── Bid split: current pot vs next pot ──
        uint256 toCurrentPot = (amount * splitBps) / 10000;
        uint256 toNextPot = amount - toCurrentPot;
        currentRound.prizePool += toCurrentPot;
        nextPrizePool += toNextPot;

        // ── Track player ──
        if (!_isPlayer[roundId][msg.sender]) {
            _isPlayer[roundId][msg.sender] = true;
            _roundPlayers[roundId].push(msg.sender);
        }

        // ── Update slot if new highest bidder ──
        if (newCumulative > slots[slotIndex].highestTotal) {
            address previousOwner = slots[slotIndex].owner;

            // Slot cap enforcement
            if (previousOwner != msg.sender) {
                // New owner taking over — check their cap
                if (playerSlotCount[roundId][msg.sender] >= maxSlotsPerPlayer) {
                    revert SlotCapReached();
                }
                playerSlotCount[roundId][msg.sender]++;
                // Free previous owner's count
                if (previousOwner != address(0)) {
                    playerSlotCount[roundId][previousOwner]--;
                }
            }

            slots[slotIndex].word = word;
            slots[slotIndex].owner = msg.sender;
            slots[slotIndex].highestTotal = newCumulative;
            emit WordSet(roundId, slotIndex, word, msg.sender, newCumulative);
        }

        emit BidPlaced(roundId, slotIndex, msg.sender, amount, newCumulative);

        // ── Transfer USDC last (CEI) ──
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @dev Only blocks spaces (0x20). Everything else is allowed.
     *      Underscores, unicode, control chars — all fair game.
     */
    function _validateWord(bytes memory wordBytes) internal pure {
        for (uint256 i = 0; i < wordBytes.length; i++) {
            if (wordBytes[i] == 0x20) revert WordContainsSpace();
        }
    }

    // ─── Oracle Resolution ───────────────────────────────────

    /**
     * @notice Oracle resolves the round. Can send to ANY address (not just players).
     *         If buffer instructions say "send to charity," that's valid.
     * @param winners Recipient addresses
     * @param usdcAmounts Exact USDC amounts (must sum to distributable after rake)
     * @param ethAmounts Exact ETH amounts (must sum to ETH prize pool, or empty array if no ETH)
     */
    function resolveRound(
        address[] calldata winners,
        uint256[] calldata usdcAmounts,
        uint256[] calldata ethAmounts
    ) external onlyOracle nonReentrant {
        _validateResolution();

        uint256 roundId = currentRound.id;

        // Must have >= 2 players for oracle resolution
        if (_roundPlayers[roundId].length < 2) revert NeedMorePlayers();

        // ── USDC distribution ──
        uint256 rake = (currentRound.prizePool * rakeBps) / 10000;
        uint256 distributable = currentRound.prizePool - rake;
        accumulatedRake += rake;

        if (winners.length != usdcAmounts.length) revert AllocationMismatch();

        uint256 usdcTotal;
        for (uint256 i = 0; i < usdcAmounts.length; i++) {
            usdcTotal += usdcAmounts[i];
        }
        if (usdcTotal != distributable) revert AllocationMismatch();

        for (uint256 i = 0; i < winners.length; i++) {
            if (usdcAmounts[i] > 0) {
                usdc.safeTransfer(winners[i], usdcAmounts[i]);
            }
        }

        // ── ETH distribution (if any) ──
        if (currentRound.ethPrizePool > 0) {
            if (ethAmounts.length != winners.length) revert AllocationMismatch();

            uint256 ethTotal;
            for (uint256 i = 0; i < ethAmounts.length; i++) {
                ethTotal += ethAmounts[i];
            }
            if (ethTotal != currentRound.ethPrizePool) revert AllocationMismatch();

            for (uint256 i = 0; i < winners.length; i++) {
                if (ethAmounts[i] > 0) {
                    (bool ok, ) = winners[i].call{value: ethAmounts[i]}("");
                    if (!ok) {
                        // Pull pattern — recipient can claim later
                        unclaimedEth[winners[i]] += ethAmounts[i];
                    }
                }
            }
        }

        // ── Finalize + auto-advance ──
        string memory buffer = getBufferAsText();
        currentRound.resolved = true;
        emit RoundResolved(roundId, buffer, winners, usdcAmounts, ethAmounts);

        _autoAdvance();
    }

    /**
     * @notice Refund a solo round. If only 1 player when time expires,
     *         refund their total spent and carry the prize pool forward.
     *         Anyone can call this.
     */
    function refundSoloRound() external nonReentrant {
        _validateResolution();

        uint256 roundId = currentRound.id;
        if (_roundPlayers[roundId].length >= 2) revert HasMultiplePlayers();

        if (_roundPlayers[roundId].length == 1) {
            address player = _roundPlayers[roundId][0];
            uint256 spent = totalSpent[roundId][player];

            // Carry prize pool forward, minus what the player put in
            // player's bids were split: currentSplit to prizePool, nextSplit to nextPrizePool
            // Refund their full spend, carry the original seed forward
            // Player's bids were split: some to prizePool, some to nextPrizePool
            // Refund their full spend, carry the original seed forward
            // Math: nextPrizePool already has nextSplit; prizePool has seed + currentSplit
            // After refund: nextPrizePool + prizePool - spent = correct carry-forward
            nextPrizePool = nextPrizePool + currentRound.prizePool - spent;

            // Carry ETH forward
            pendingEth += currentRound.ethPrizePool;

            // Refund player
            if (spent > 0) {
                usdc.safeTransfer(player, spent);
            }

            emit SoloRoundRefunded(roundId, player, spent);
        } else {
            // 0 players — just carry everything forward
            nextPrizePool += currentRound.prizePool;
            pendingEth += currentRound.ethPrizePool;
            emit SoloRoundRefunded(roundId, address(0), 0);
        }

        currentRound.resolved = true;
        _autoAdvance();
    }

    /**
     * @notice Emergency resolve: if oracle hasn't resolved within 24h after round end,
     *         owner can trigger proportional distribution based on total spend.
     */
    function emergencyResolve() external onlyOwner nonReentrant {
        _validateResolution();
        if (block.timestamp < currentRound.endTime + EMERGENCY_TIMEOUT) revert EmergencyNotReady();

        uint256 roundId = currentRound.id;
        address[] memory players = _roundPlayers[roundId];

        // If < 2 players, treat as solo refund
        if (players.length < 2) {
            // Reuse solo logic — call internal version
            _emergencySoloRefund(roundId, players);
            return;
        }

        uint256 totalBids;
        for (uint256 i = 0; i < players.length; i++) {
            totalBids += totalSpent[roundId][players[i]];
        }

        // ── USDC proportional distribution ──
        uint256 rake = (currentRound.prizePool * rakeBps) / 10000;
        uint256 distributable = currentRound.prizePool - rake;
        accumulatedRake += rake;

        address[] memory winners = new address[](players.length);
        uint256[] memory usdcAllocs = new uint256[](players.length);
        uint256[] memory ethAllocs = new uint256[](players.length);
        uint256 usdcDistributed;
        uint256 ethDistributed;

        for (uint256 i = 0; i < players.length; i++) {
            winners[i] = players[i];
            if (totalBids > 0) {
                usdcAllocs[i] = (distributable * totalSpent[roundId][players[i]]) / totalBids;
                ethAllocs[i] = (currentRound.ethPrizePool * totalSpent[roundId][players[i]]) / totalBids;
            }
            usdcDistributed += usdcAllocs[i];
            ethDistributed += ethAllocs[i];
        }

        // Rounding dust to last player
        if (usdcDistributed < distributable && players.length > 0) {
            usdcAllocs[players.length - 1] += distributable - usdcDistributed;
        }
        if (ethDistributed < currentRound.ethPrizePool && players.length > 0) {
            ethAllocs[players.length - 1] += currentRound.ethPrizePool - ethDistributed;
        }

        // ── Transfer ──
        for (uint256 i = 0; i < winners.length; i++) {
            if (usdcAllocs[i] > 0) {
                usdc.safeTransfer(winners[i], usdcAllocs[i]);
            }
            if (ethAllocs[i] > 0) {
                (bool ok, ) = winners[i].call{value: ethAllocs[i]}("");
                if (!ok) {
                    unclaimedEth[winners[i]] += ethAllocs[i];
                }
            }
        }

        string memory buffer = getBufferAsText();
        currentRound.resolved = true;
        emit EmergencyResolved(roundId);
        emit RoundResolved(roundId, buffer, winners, usdcAllocs, ethAllocs);

        _autoAdvance();
    }

    /// @notice Claim ETH that failed to transfer during resolution
    function claimEth() external nonReentrant {
        uint256 amount = unclaimedEth[msg.sender];
        if (amount == 0) revert NothingToClaim();
        unclaimedEth[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH transfer failed");
        emit EthClaimed(msg.sender, amount);
    }

    // ─── Internal ────────────────────────────────────────────

    function _validateResolution() internal view {
        if (currentRound.id == 0) revert NoActiveRound();
        if (currentRound.resolved) revert RoundAlreadyResolved();
        if (currentRound.startedAt == 0) revert RoundNotStarted();
        if (block.timestamp < currentRound.endTime) revert RoundStillActive();
    }

    function _createRound(uint256 usdcPrize, uint256 ethPrize, address creator) internal {
        // Clear slots
        for (uint256 i = 0; i < NUM_SLOTS; i++) {
            delete slots[i];
        }

        uint256 newId = currentRound.id + 1;
        currentRound = Round({
            id: newId,
            createdAt: block.timestamp,
            startedAt: 0,       // pending — no timer yet
            endTime: 0,
            prizePool: usdcPrize,
            ethPrizePool: ethPrize,
            resolved: false
        });

        emit RoundCreated(newId, usdcPrize, ethPrize, creator);
    }

    function _autoAdvance() internal {
        if (nextPrizePool >= MIN_AUTO_START) {
            uint256 prize = nextPrizePool;
            nextPrizePool = 0;
            _createRound(prize, pendingEth, address(this));
            pendingEth = 0;
        }
    }

    function _emergencySoloRefund(uint256 roundId, address[] memory players) internal {
        if (players.length == 1) {
            address player = players[0];
            uint256 spent = totalSpent[roundId][player];
            nextPrizePool = nextPrizePool + currentRound.prizePool - spent;
            pendingEth += currentRound.ethPrizePool;
            if (spent > 0) {
                usdc.safeTransfer(player, spent);
            }
            emit SoloRoundRefunded(roundId, player, spent);
        } else {
            nextPrizePool += currentRound.prizePool;
            pendingEth += currentRound.ethPrizePool;
            emit SoloRoundRefunded(roundId, address(0), 0);
        }
        currentRound.resolved = true;
        emit EmergencyResolved(roundId);
        _autoAdvance();
    }

    // ─── Rescue ──────────────────────────────────────────────

    /// @notice Rescue random ERC20 tokens sent to this contract
    function rescueToken(address token) external onlyOwner {
        require(token != address(usdc), "Use withdrawRake for USDC");
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(owner(), balance);
    }

    /// @notice Rescue ETH not assigned to any round or unclaimed pool
    function rescueEth() external onlyOwner {
        uint256 committed = currentRound.ethPrizePool + pendingEth;
        // Calculate total unclaimed
        // Note: we can't easily sum all unclaimedEth, so just protect known commitments
        uint256 rescuable = address(this).balance - committed;
        require(rescuable > 0, "Nothing to rescue");
        (bool ok, ) = owner().call{value: rescuable}("");
        require(ok, "ETH transfer failed");
    }

    // ─── View Functions ──────────────────────────────────────

    function getBuffer() external view returns (string[12] memory words) {
        for (uint256 i = 0; i < NUM_SLOTS; i++) {
            words[i] = slots[i].word;
        }
    }

    function getBufferAsText() public view returns (string memory) {
        bytes memory result;
        bool first = true;
        for (uint256 i = 0; i < NUM_SLOTS; i++) {
            if (bytes(slots[i].word).length > 0) {
                if (!first) result = abi.encodePacked(result, " ");
                result = abi.encodePacked(result, slots[i].word);
                first = false;
            }
        }
        return string(result);
    }

    function getSlot(uint256 index) external view returns (
        string memory word, address owner, uint256 highestTotal
    ) {
        if (index >= NUM_SLOTS) revert InvalidSlot();
        WordSlot storage s = slots[index];
        return (s.word, s.owner, s.highestTotal);
    }

    function getSlotOwners() external view returns (address[12] memory owners) {
        for (uint256 i = 0; i < NUM_SLOTS; i++) owners[i] = slots[i].owner;
    }

    function getRoundPlayers(uint256 roundId) external view returns (address[] memory) {
        return _roundPlayers[roundId];
    }

    function playerCount(uint256 roundId) external view returns (uint256) {
        return _roundPlayers[roundId].length;
    }

    function getRoundInfo() external view returns (
        uint256 id,
        uint256 createdAt,
        uint256 startedAt,
        uint256 endTime,
        uint256 prizePool,
        uint256 ethPrizePool,
        bool resolved,
        bool pending,
        bool active
    ) {
        Round storage r = currentRound;
        bool isPending = r.id > 0 && !r.resolved && r.startedAt == 0;
        bool isActive = r.id > 0 && !r.resolved &&
                        r.startedAt > 0 &&
                        block.timestamp < r.endTime;
        return (
            r.id, r.createdAt, r.startedAt, r.endTime,
            r.prizePool, r.ethPrizePool,
            r.resolved, isPending, isActive
        );
    }
}
