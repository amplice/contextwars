# Context War v4 Spec

## 1. Bid split: current pot vs next pot
- Bids split between current round prize pool and next round pool
- **Configurable ratio** via owner-settable `splitBps` (e.g., 5000 = 50/50)
- Default: 50% current, 50% next
- This makes the game self-sustaining while still escalating the current round

## 2. Auto-start rounds + clock on first bid
- When a round resolves, the next round auto-creates with the accumulated `nextPrizePool`
- Round sits "open" — accepting bids, pot visible, but **no ticking clock**
- **First bid triggers the countdown timer**
- If nobody bids, round just sits there indefinitely — that's fine
- No dead time, no manual starts, infinite game loop
- Implementation:
  - `roundCreatedAt` (set on resolve) vs `roundStartedAt` (set on first bid)
  - `endTime = roundStartedAt + roundDuration`
  - Before first bid: round is "pending" (open for bids, no timer)
  - After first bid: round is "active" (timer running)
- **Min prize threshold**: don't auto-start if `nextPrizePool < 1 USDC` (1000000 raw)

## 3. Direct funding → current prize pool
- `fund(uint256 amount)` — anyone can call, adds USDC to **current** round's prize pool
- `usdc.safeTransferFrom(sender, contract, amount)` + `currentRound.prizePool += amount`
- Emits `Funded(address funder, uint256 amount, uint256 roundId)` event
- Use case: seeding pots, sponsors, anyone who wants to make a round juicier

## 4. Slot character limit: 22 chars
- Max 22 characters per slot (down from 32)
- Half an ETH address at best — forces reference-based strategies over raw addresses
- Enough for compound words, short instructions, partial identifiers
- Players have to get creative: "send2slot5owner", "NOTmick", "0x0b538084" (partial)
- On-chain enforcement: `bytes(word).length > 22` → revert

## 5. Input validation: block spaces only
- On-chain: reject words containing space (0x20) — that's it
- Underscores allowed — valid strategy choice
- Unicode tricks, control chars, zero-width spaces: **allowed** — creativity is the point
- If someone finds a clever encoding trick, that's part of the game
- Keep validation minimal and let the meta evolve

## 6. Minimum 2 players to resolve
- If only 1 player when round ends → auto-refund to that player + carry pot forward
- Prevents self-play exploits (bidding against yourself to claim seed)
- Oracle only called when ≥2 distinct players participated
- **Sybil acknowledged**: someone can use 2 wallets — not solvable on-chain, accepted trade-off

## 7. Slot ownership cap (toggleable)
- Owner-settable `maxSlotsPerPlayer` — default **6** (of 12)
- Prevents total domination, forces coalition/competitive dynamics
- **Toggleable**: set to 12 to disable the cap
- On-chain enforcement: track slot ownership count per player per round, revert if exceeds cap
- Taking over a slot from another player frees their count

## 8. ETH support + token rescue
- `receive() external payable` — contract accepts ETH
- Track ETH balance separately, oracle distributes both USDC and ETH
- Random ERC20s: owner-only `rescueToken(address token)` sweep function
- Keep it simple — don't try to auto-distribute unknown tokens

## 9. Round history on-chain
- `RoundResolved` event includes full allocation details
- `event RoundResolved(uint256 indexed roundId, address[] winners, uint256[] amounts, string bufferText)`
- Makes results verifiable without tracing transactions

## 10. Configurable split ratio
- `splitBps` — owner-settable, controls bid split between current/next pot
- 5000 = 50/50 (default)
- 10000 = 100% to current (v3 behavior)
- 0 = 100% to next (pure seed-forward)
- Can tune based on gameplay dynamics

## 11. Anti-snipe: bid extension
- If any bid lands in the **last 1 minute** of a round, extend the timer by **1 minute**
- Prevents last-second sniping, forces real competition
- Standard auction mechanic — simple and fair
- No cap on extensions (round runs until 1 full minute of no bids)

## 12. Oracle: no player validation
- Oracle can send to ANY address, not just round players
- If someone crafts a buffer that sends funds to a charity ENS or random address, that's a valid win condition
- The buffer is the instruction — oracle follows it literally
- This is a feature, not a bug

## 13. Emergency resolve + auto-start handoff
- Emergency resolve should clean up properly before auto-start triggers
- Sequence: emergency resolve → distribute → auto-create next round
- Same flow as normal resolve, just different trigger

---

## Observations from round 1 (informing v4)
- Multi-word injection via spaces was a real exploit vector
- Underscore bypass: "send_funds_to_adrianleb.eth" — frontend blocked spaces but not underscores
- Defense bots are viable and probably necessary
- 5 players in round 1 organically — game works
- Specific instructions beat general ones — "send all to 0x0b538084" > "distribute to highest spender"
- Period punctuation does NOT defend against injection — Claude ignores "." as sentence boundary
- Owning all 12 slots = guaranteed win if no one contests (but slot cap changes this)
- Partial addresses (e.g., "0x0b538084") were unique enough among 5 players
