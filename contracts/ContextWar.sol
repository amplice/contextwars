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
 *         12 word slots. Agents bid USDC to control words.
 *         Cumulative bidding — highest total spend per slot wins.
 *         Oracle (fresh Claude instance) reads the buffer and distributes the prize.
 *         Bids from current round fund the NEXT round's prize (infinite game).
 *         Words enforced as single tokens — no spaces or underscores.
 */
contract ContextWar is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant NUM_SLOTS = 12;
    uint256 public constant MAX_RAKE_BPS = 2000; // 20% max rake
    uint256 public constant EMERGENCY_TIMEOUT = 24 hours;

    struct WordSlot {
        string word;
        address owner;
        uint256 highestTotal;
    }

    struct Round {
        uint256 id;
        uint256 startTime;
        uint256 endTime;
        uint256 prizePool;
        bool resolved;
    }

    IERC20 public immutable usdc;
    uint256 public minBid;
    address public oracleAddress;
    uint256 public roundDuration;       // fixed duration, owner-adjustable
    uint256 public rakeBps;             // basis points: 0 = 0%, 500 = 5%, 1000 = 10%
    uint256 public accumulatedRake;     // unclaimed rake
    uint256 public nextPrizePool;       // bids from current round, becomes next round's prize

    Round public currentRound;
    WordSlot[NUM_SLOTS] public slots;

    mapping(uint256 => mapping(uint256 => mapping(address => uint256))) public cumulativeBids;
    mapping(uint256 => address[]) private _roundPlayers;
    mapping(uint256 => mapping(address => bool)) private _isPlayer;
    mapping(uint256 => mapping(address => uint256)) public totalSpent;

    // Events
    event RoundStarted(uint256 indexed roundId, uint256 startTime, uint256 endTime, uint256 prizePool, address starter);
    event WordSet(uint256 indexed roundId, uint256 indexed slot, string word, address indexed owner, uint256 cumulative);
    event BidPlaced(uint256 indexed roundId, uint256 indexed slot, address indexed bidder, uint256 amount, uint256 cumulative);
    event RoundResolved(uint256 indexed roundId, string finalBuffer, address[] winners, uint256[] amounts);
    event EmergencyResolved(uint256 indexed roundId);
    event RakeUpdated(uint256 oldBps, uint256 newBps);
    event DurationUpdated(uint256 oldDuration, uint256 newDuration);
    event OracleUpdated(address oldOracle, address newOracle);
    event MinBidUpdated(uint256 oldMinBid, uint256 newMinBid);
    event RakeWithdrawn(uint256 amount);

    error RoundNotActive();
    error RoundStillActive();
    error RoundAlreadyResolved();
    error PreviousRoundNotResolved();
    error InvalidSlot();
    error BidTooLow();
    error NotOracle();
    error AllocationMismatch();
    error NoActiveRound();
    error WordTooLong();
    error WordContainsInvalidChar();
    error RakeTooHigh();
    error EmptyPrizePool();
    error EmergencyNotReady();

    modifier onlyOracle() {
        if (msg.sender != oracleAddress) revert NotOracle();
        _;
    }

    modifier roundActive() {
        if (currentRound.id == 0) revert NoActiveRound();
        if (block.timestamp < currentRound.startTime) revert RoundNotActive();
        if (block.timestamp >= currentRound.endTime) revert RoundNotActive();
        if (currentRound.resolved) revert RoundAlreadyResolved();
        _;
    }

    constructor(
        address _usdc,
        address _oracle,
        uint256 _minBid,
        uint256 _roundDuration,
        uint256 _rakeBps
    ) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        oracleAddress = _oracle;
        minBid = _minBid;
        roundDuration = _roundDuration;
        if (_rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        rakeBps = _rakeBps;
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
     * @notice Start a new round. Anyone can call once the previous round is resolved.
     *         Duration is fixed (set by owner). Prize = recycled bids + optional top-up.
     * @param topUp Optional extra USDC to add to the prize pool.
     */
    function startRound(uint256 topUp) external whenNotPaused {
        if (currentRound.id > 0 && !currentRound.resolved) {
            revert PreviousRoundNotResolved();
        }

        if (topUp > 0) {
            usdc.safeTransferFrom(msg.sender, address(this), topUp);
        }

        // Prize = accumulated bids from previous round + any top-up + leftover from resolution
        uint256 prize = nextPrizePool + topUp;
        // Also include any USDC that wasn't distributed (e.g. from partial resolution)
        uint256 contractBalance = usdc.balanceOf(address(this)) - accumulatedRake;
        // Use the greater of tracked nextPrizePool+topUp or actual balance
        // (handles first round where nextPrizePool is 0 but topUp was sent)
        if (contractBalance > prize) {
            prize = contractBalance;
        }
        if (prize == 0) revert EmptyPrizePool();

        // Reset next prize pool
        nextPrizePool = 0;

        for (uint256 i = 0; i < NUM_SLOTS; i++) {
            delete slots[i];
        }

        uint256 newId = currentRound.id + 1;
        currentRound = Round({
            id: newId,
            startTime: block.timestamp,
            endTime: block.timestamp + roundDuration,
            prizePool: prize,
            resolved: false
        });

        emit RoundStarted(newId, block.timestamp, block.timestamp + roundDuration, prize, msg.sender);
    }

    // ─── Bidding ─────────────────────────────────────────────

    function bid(uint256 slotIndex, string calldata word, uint256 amount) 
        external 
        roundActive 
        whenNotPaused 
        nonReentrant 
    {
        if (slotIndex >= NUM_SLOTS) revert InvalidSlot();
        if (amount < minBid) revert BidTooLow();
        bytes memory wordBytes = bytes(word);
        if (wordBytes.length > 32) revert WordTooLong();
        if (wordBytes.length == 0) revert WordTooLong();
        _validateWord(wordBytes);

        uint256 roundId = currentRound.id;

        // Update state first (CEI)
        cumulativeBids[roundId][slotIndex][msg.sender] += amount;
        uint256 newCumulative = cumulativeBids[roundId][slotIndex][msg.sender];

        totalSpent[roundId][msg.sender] += amount;
        // Bids fund the NEXT round, not the current one
        nextPrizePool += amount;

        if (!_isPlayer[roundId][msg.sender]) {
            _isPlayer[roundId][msg.sender] = true;
            _roundPlayers[roundId].push(msg.sender);
        }

        if (newCumulative > slots[slotIndex].highestTotal) {
            slots[slotIndex].word = word;
            slots[slotIndex].owner = msg.sender;
            slots[slotIndex].highestTotal = newCumulative;
            emit WordSet(roundId, slotIndex, word, msg.sender, newCumulative);
        }

        emit BidPlaced(roundId, slotIndex, msg.sender, amount, newCumulative);

        // External call last
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @dev Validates that a word contains only allowed characters.
     *      Rejects spaces (0x20) and underscores (0x5F).
     */
    function _validateWord(bytes memory wordBytes) internal pure {
        for (uint256 i = 0; i < wordBytes.length; i++) {
            bytes1 b = wordBytes[i];
            if (b == 0x20 || b == 0x5F) revert WordContainsInvalidChar();
        }
    }

    // ─── Oracle Resolution ───────────────────────────────────

    function resolveRound(
        address[] calldata winners,
        uint256[] calldata amounts
    ) external onlyOracle nonReentrant {
        _resolve(winners, amounts);
    }

    /**
     * @notice Emergency resolve: if oracle hasn't resolved within 24h after round end,
     *         owner can trigger proportional distribution based on total spend.
     */
    function emergencyResolve() external onlyOwner nonReentrant {
        if (currentRound.id == 0) revert NoActiveRound();
        if (currentRound.resolved) revert RoundAlreadyResolved();
        if (block.timestamp < currentRound.endTime + EMERGENCY_TIMEOUT) revert EmergencyNotReady();

        uint256 roundId = currentRound.id;
        address[] memory players = _roundPlayers[roundId];
        uint256 totalBids;
        for (uint256 i = 0; i < players.length; i++) {
            totalBids += totalSpent[roundId][players[i]];
        }

        // Apply rake
        uint256 rake = (currentRound.prizePool * rakeBps) / 10000;
        uint256 distributable = currentRound.prizePool - rake;
        accumulatedRake += rake;

        // Proportional distribution
        address[] memory winners = new address[](players.length);
        uint256[] memory allocs = new uint256[](players.length);
        uint256 distributed;

        for (uint256 i = 0; i < players.length; i++) {
            winners[i] = players[i];
            if (totalBids > 0) {
                allocs[i] = (distributable * totalSpent[roundId][players[i]]) / totalBids;
            }
            distributed += allocs[i];
        }
        // Rounding dust to first player
        if (distributed < distributable && players.length > 0) {
            allocs[0] += distributable - distributed;
        }

        for (uint256 i = 0; i < winners.length; i++) {
            if (allocs[i] > 0) {
                usdc.safeTransfer(winners[i], allocs[i]);
            }
        }

        currentRound.resolved = true;
        emit EmergencyResolved(roundId);
        emit RoundResolved(roundId, getBufferAsText(), winners, allocs);
    }

    function _resolve(
        address[] calldata winners,
        uint256[] calldata amounts
    ) internal {
        if (currentRound.id == 0) revert NoActiveRound();
        if (block.timestamp < currentRound.endTime) revert RoundStillActive();
        if (currentRound.resolved) revert RoundAlreadyResolved();
        if (winners.length != amounts.length) revert AllocationMismatch();

        // Apply rake
        uint256 rake = (currentRound.prizePool * rakeBps) / 10000;
        uint256 distributable = currentRound.prizePool - rake;
        accumulatedRake += rake;

        // Verify total allocation equals distributable amount (after rake)
        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        if (total != distributable) revert AllocationMismatch();

        for (uint256 i = 0; i < winners.length; i++) {
            if (amounts[i] > 0) {
                usdc.safeTransfer(winners[i], amounts[i]);
            }
        }

        currentRound.resolved = true;
        emit RoundResolved(currentRound.id, getBufferAsText(), winners, amounts);
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

    function getRoundInfo() external view returns (
        uint256 id, uint256 startTime, uint256 endTime, uint256 prizePool,
        bool resolved, bool active
    ) {
        Round storage r = currentRound;
        bool isActive = r.id > 0 && !r.resolved && 
                        block.timestamp >= r.startTime && 
                        block.timestamp < r.endTime;
        return (r.id, r.startTime, r.endTime, r.prizePool, r.resolved, isActive);
    }

    function pendingPrizePool() external view returns (uint256) {
        return nextPrizePool;
    }

    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(usdc) && currentRound.id > 0 && !currentRound.resolved) {
            revert PreviousRoundNotResolved();
        }
        IERC20(token).safeTransfer(owner(), amount);
    }
}
