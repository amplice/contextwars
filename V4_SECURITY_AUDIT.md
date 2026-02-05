# Context War v4 Security Audit

## Executive Summary
This audit identifies critical vulnerabilities in the Context War v4 specification and smart contract implementation. Key issues include missing features from the spec, potential reentrancy vectors, game theory exploits, and input validation bypasses.

## Critical Findings

### CRITICAL-001: ETH Support Missing in Contract
**Severity:** CRITICAL
**Description:** The V4_NOTES.md spec mentions "ETH support + token rescue" and tracking ETH separately, but the smart contract has no `receive()` function or ETH handling logic.
**Impact:** Game cannot accept ETH as promised, breaking a key feature.
**Fix:** Add `receive() external payable {}` and ETH distribution logic in resolution functions.

### CRITICAL-002: Slot Ownership Cap Not Implemented
**Severity:** CRITICAL  
**Description:** Spec mentions "maxSlotsPerPlayer" default of 6 slots with toggleable cap, but this is completely missing from the contract code.
**Impact:** Players can own all 12 slots, breaking the intended game mechanics and allowing guaranteed self-wins.
**Fix:** Implement slot ownership tracking and enforcement in the `bid()` function.

### CRITICAL-003: Auto-start Mechanism Missing
**Severity:** CRITICAL
**Description:** Spec describes auto-start rounds with clock on first bid, but contract only has manual `startRound()` function.
**Impact:** Game requires manual intervention between rounds, breaking the "infinite game loop" design.
**Fix:** Implement auto-round creation in resolution functions with clock starting on first bid.

### CRITICAL-004: Bid Split Logic Missing
**Severity:** CRITICAL
**Description:** Spec mentions configurable `splitBps` for current vs next pot splitting, but contract hardcodes 100% to next round.
**Impact:** Cannot tune game economics as intended, breaks bidding incentive structure.
**Fix:** Add `splitBps` state variable and implement split logic in `bid()` function.

## High Severity Issues

### HIGH-001: Direct USDC Funding Function Missing
**Severity:** HIGH
**Description:** Spec mentions `fund(uint256 amount)` for direct prize pool funding, but this function doesn't exist.
**Impact:** Cannot seed or boost current rounds as designed.
**Fix:** Implement `fund()` function that adds to current round prize pool.

### HIGH-002: Integer Overflow in Emergency Resolution
**Severity:** HIGH
**Description:** Emergency resolution calculates `(distributable * totalSpent[roundId][players[i]]) / totalBids` which can overflow for large values.
**Impact:** Emergency resolution could fail or distribute incorrect amounts.
**Fix:** Use SafeMath or check for overflow before multiplication.

### HIGH-003: Rounding Dust Arbitrary Assignment
**Severity:** HIGH
**Description:** Emergency resolution gives all rounding dust to `players[0]`, which could be manipulated.
**Impact:** First player gets disproportionate benefit from rounding errors.
**Fix:** Distribute dust more fairly or to last resolver.

### HIGH-004: Oracle Can Send to Non-Players
**Severity:** HIGH
**Description:** Oracle resolution accepts arbitrary `winners` array with no validation that winners participated in the round.
**Impact:** Oracle could send funds to external addresses, potentially draining the contract.
**Fix:** Validate that all winners are in `_roundPlayers[roundId]` array.

### HIGH-005: Partial Oracle Resolution Not Handled
**Severity:** HIGH
**Description:** If oracle sends `total != distributable`, transaction reverts but oracle can't retry with corrected amounts.
**Impact:** Rounds could become permanently stuck if oracle makes calculation errors.
**Fix:** Allow partial resolution or provide oracle retry mechanism.

## Medium Severity Issues

### MEDIUM-001: Word Validation Unicode Bypass
**Severity:** MEDIUM
**Description:** `_validateWord()` only checks individual bytes, not unicode characters. Zero-width spaces (0xE2 0x80 0x8B) and other multi-byte whitespace pass validation.
**Impact:** Players can inject hidden whitespace that may confuse the oracle.
**Fix:** Validate against specific unicode whitespace codepoints, not just bytes.

### MEDIUM-002: Emergency Timeout Race Condition
**Severity:** MEDIUM
**Description:** Between `block.timestamp >= currentRound.endTime + EMERGENCY_TIMEOUT` check and actual resolution, oracle could still call `resolveRound()`.
**Impact:** Potential for dual resolution if oracle and owner call simultaneously.
**Fix:** Add a flag to prevent oracle resolution after emergency timeout.

### MEDIUM-003: Rake Withdrawal Timing Attack
**Severity:** MEDIUM
**Description:** Owner can withdraw accumulated rake at any time, potentially just before a large round resolves.
**Impact:** Could appear as exit scam if timing looks suspicious.
**Fix:** Consider time-locked or predictable rake withdrawal schedule.

### MEDIUM-004: No Minimum Player Requirement
**Severity:** MEDIUM
**Description:** Spec mentions "Minimum 2 players to resolve" but contract allows resolution with any number of players.
**Impact:** Single players could claim entire prize pools.
**Fix:** Check `_roundPlayers.length >= 2` before allowing resolution.

### MEDIUM-005: Gas Griefing via Tiny Bids
**Severity:** MEDIUM
**Description:** Players can spam tiny `minBid` amounts to force expensive iteration in emergency resolution.
**Impact:** High gas costs for emergency resolution, potentially making it economically unviable.
**Fix:** Implement minimum bid scaling or gas usage caps.

## Low Severity Issues

### LOW-001: Word Length Edge Cases
**Severity:** LOW
**Description:** Word validation allows empty strings to pass initial length check but fails at `wordBytes.length == 0`.
**Impact:** Confusing error messages for empty word submissions.
**Fix:** Explicitly check for empty strings first.

### LOW-002: Slot Index Off-By-One Potential
**Severity:** LOW
**Description:** Contract uses 0-11 indexing but frontend/users might expect 1-12.
**Impact:** UI confusion about slot numbering.
**Fix:** Document indexing clearly or use 1-12 internally.

### LOW-003: Event Parameter Misalignment
**Severity:** LOW
**Description:** `RoundResolved` event in spec includes `bufferText` but contract implementation uses `getBufferAsText()`.
**Impact:** Minor deviation from spec, but events match.
**Fix:** Update spec or contract to align.

### LOW-004: No Player Bid History Query
**Severity:** LOW
**Description:** Cannot easily query total bids by a player across all slots in a round.
**Impact:** Poor UX for tracking player involvement.
**Fix:** Add view function for player bid summaries.

## Game Theory Exploits

### EXPLOIT-001: Sybil Attack for Minimum Players
**Severity:** HIGH
**Description:** Player can create second wallet, bid minimum on both to meet 2-player requirement, then guarantee win.
**Impact:** Game becomes deterministic for dedicated attackers.
**Fix:** Require higher minimum participation thresholds or player verification.

### EXPLOIT-002: Last-Second Bid Sniper
**Severity:** MEDIUM  
**Description:** No bid extension mechanism means players can snipe slots in final seconds.
**Impact:** Game favors technical users with better timing over strategic players.
**Fix:** Implement bid extension (e.g., +5 minutes if bid in last 5 minutes).

### EXPLOIT-003: Chicken Game on Round Start
**Severity:** MEDIUM
**Description:** If first bid starts timer, players may wait indefinitely for others to start the clock.
**Impact:** Rounds could sit inactive indefinitely.
**Fix:** Add maximum "pending" time before auto-start or forced resolution.

### EXPLOIT-004: Next Round Funding Griefing
**Severity:** LOW
**Description:** Players pay to make next round attractive for opponents, creating perverse incentives.
**Impact:** Optimal strategy might be to never bid, just wait for others to fund next rounds.
**Fix:** Ensure bidders get proportional advantage in the round they fund.

## Input Validation Bypasses

### BYPASS-001: Control Character Injection
**Severity:** MEDIUM
**Description:** Validation only blocks space (0x20) and underscore (0x5F) but allows other ASCII control characters like tab (0x09), newline (0x0A).
**Impact:** Players can inject formatting that might confuse oracle parsing.
**Fix:** Whitelist allowed characters rather than blacklisting specific ones.

### BYPASS-002: Null Byte Injection
**Severity:** LOW
**Description:** Null bytes (0x00) in words could truncate strings in various contexts.
**Impact:** Potential string handling inconsistencies.
**Fix:** Explicitly reject null bytes and other control characters.

### BYPASS-003: Unicode Normalization Issues
**Severity:** LOW
**Description:** Unicode characters could normalize differently across systems.
**Impact:** Display inconsistencies between frontend and oracle.
**Fix:** Implement unicode normalization before validation.

## Economic Attack Vectors

### ECONOMIC-001: Dust Round Exploit
**Severity:** MEDIUM
**Description:** If `nextPrizePool` is extremely small (0.000001 USDC), resolution costs may exceed prize value.
**Impact:** Game could become economically unviable for very small rounds.
**Fix:** Implement minimum prize pool threshold for auto-start.

### ECONOMIC-002: Gas Cost vs Min Bid Imbalance
**Severity:** LOW
**Description:** Gas costs for bidding might exceed 0.25 USDC minimum bid during network congestion.
**Impact:** Game becomes uneconomical during high gas periods.
**Fix:** Dynamic minimum bid based on gas prices or L2 deployment.

### ECONOMIC-003: Repeated Min Bid Drain
**Severity:** LOW
**Description:** Players could repeatedly bid minimum amounts to slowly drain through rake accumulation.
**Impact:** Long-term value extraction from game treasury.
**Fix:** Minimum bid scaling with round value or anti-farming measures.

## Missing Features from Specification

### MISSING-001: Emergency Token Rescue
**Severity:** MEDIUM
**Description:** Spec mentions `rescueToken()` for random ERC20s but contract only has `emergencyWithdraw()`.
**Impact:** Cannot rescue unexpected tokens sent to contract.
**Fix:** Implement proper token rescue function with appropriate safeguards.

### MISSING-002: Round History Events
**Severity:** LOW
**Description:** Contract events don't fully match spec descriptions for round history.
**Impact:** Indexing and analysis tools may not work as expected.
**Fix:** Align event specifications with implementation.

### MISSING-003: Clock State Tracking
**Severity:** HIGH
**Description:** No distinction between "pending" (pre-first-bid) and "active" (post-first-bid) round states.
**Impact:** Cannot implement clock-on-first-bid mechanism.
**Fix:** Add round state tracking with separate start/pending timestamps.

## Recommendations

### Immediate Fixes Required
1. Implement all missing features from specification (slot caps, auto-start, bid splitting)
2. Add proper ETH support with receive() function
3. Fix oracle validation to prevent funds going to non-players
4. Implement minimum player requirement enforcement
5. Add comprehensive input validation for unicode and control characters

### Architecture Improvements
1. Consider bid extension mechanism to prevent sniping
2. Implement more sophisticated anti-sybil measures
3. Add gas usage controls for emergency resolution
4. Consider L2 deployment to reduce transaction costs

### Game Theory Enhancements  
1. Adjust incentive structure to prevent chicken games
2. Consider bid bonus for round starters
3. Implement more nuanced profit-sharing between current and next rounds

### Long-term Considerations
1. Decentralized oracle system to reduce single point of failure
2. Governance mechanisms for parameter adjustments
3. Integration with reputation/identity systems
4. Tournament or league structures for recurring play

## Testing Recommendations
1. Fuzzing test with malformed unicode strings
2. Stress test emergency resolution with many small bids
3. Race condition testing between oracle and emergency resolution
4. Economic modeling of various game theory scenarios
5. Front-running simulation for last-second bids

This audit reveals significant gaps between the specification and implementation that must be addressed before deployment.