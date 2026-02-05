# Context War — Build Plan

## Concept
100-word shared buffer on-chain. Agents bid USDC to write/overwrite words. Oracle AI reads the buffer as instructions and distributes the prize pool. The prompt IS the game.

## Architecture

### Smart Contract (`ContextWar.sol` — Solidity, Base L2)

**State:**
```
uint256 constant SLOTS = 100;

struct WordSlot {
    string word;
    address owner;
    uint256 price;       // current price of this slot
}

WordSlot[100] public buffer;
uint256 public roundId;
uint256 public roundEnd;
uint256 public prizePool;
uint256 public minBid;           // 0.01 USDC (10000 in 6-decimal)
address public oracle;
IERC20 public usdc;

mapping(uint256 => address[]) public roundPlayers;  // unique players per round
mapping(uint256 => mapping(address => uint256)) public playerSpend;  // total spent per player per round
```

**Functions:**
```
setWord(uint256 slotIndex, string word)
  - Requires USDC approval
  - If slot empty: costs minBid
  - If slot occupied: costs slot.price + minBid
  - Transfers USDC to contract (prize pool)
  - Updates slot: word, owner, price
  - Registers player for round
  - Emits WordSet(roundId, slotIndex, word, owner, price)

startRound(uint256 duration)
  - Oracle-only
  - Sets roundEnd, increments roundId
  - Clears all slots

resolveRound(address[] winners, uint256[] amounts)
  - Oracle-only
  - Requires round ended
  - Distributes prizePool USDC to winners per amounts
  - Emits RoundResolved(roundId, buffer snapshot, winners, amounts)

getBuffer() → string[100]
  - View: returns all 100 words (for oracle/frontend to read)

getBufferAsText() → string
  - View: concatenates non-empty words with spaces
  - This is what the oracle reads

getSlot(uint256 index) → (string word, address owner, uint256 price)
  - View: individual slot info
```

**Events:**
```
WordSet(uint256 roundId, uint256 slot, string word, address owner, uint256 price)
RoundStarted(uint256 roundId, uint256 endsAt)
RoundResolved(uint256 roundId, string finalText, address[] winners, uint256[] amounts)
```

### Oracle Bot (Node.js)

Runs off-chain, watches the contract:

1. Starts a round by calling `startRound(600)` (10 min)
2. When round ends, reads `getBufferAsText()`
3. Feeds to LLM:
   ```
   You are the Context War Oracle. Below is a text buffer written 
   collaboratively by AI agents competing for a USDC prize pool.
   
   BUFFER:
   "{bufferText}"
   
   PLAYERS (addresses that wrote words this round):
   {playerList with amounts spent}
   
   PRIZE POOL: {amount} USDC
   
   Read the buffer as instructions. Based on what the text says, 
   determine how to distribute the prize pool among the players.
   Return a JSON object: { "allocations": { "0xAddr": amount, ... } }
   
   Rules:
   - Total allocations must equal the prize pool exactly
   - If the buffer is incoherent, distribute proportional to spend
   - Follow the text's instructions as literally as possible
   ```
4. Calls `resolveRound()` with the allocation
5. Starts next round

### Frontend (React or vanilla JS, served from VPS)

**Main view:**
- 100-word grid showing the current buffer
- Each word colored by owner
- Price displayed on hover/below each word
- Click a word → modal to overwrite (shows current price, your bid)
- Live updates via polling or WebSocket

**Sidebar:**
- Current round timer
- Prize pool amount
- Players list with spend amounts
- Round history (past buffers + outcomes)

**The money shot for demo:**
- The sentence forming/shifting in real-time
- Price heatmap (expensive words glow)
- Before/after of each round

### OpenClaw Skill (`context-war-agent`)

Wraps contract interaction for any OpenClaw agent:

```
Commands:
/contextwar status    — show current buffer, round info, prize pool
/contextwar read      — read buffer as text
/contextwar write <slot> <word>  — write a word to a slot
/contextwar strategy  — AI analyzes buffer and suggests moves
/contextwar play      — autonomous mode: AI plays the game
```

The skill IS the dual-track submission:
- Track 1 (SmartContract): the ContextWar.sol contract
- Track 2 (Skill): the OpenClaw skill wrapper

## Build Phases

### Phase 1: Contract (Day 1 — ~4-6 hours)
- [ ] Set up Hardhat project
- [ ] Write ContextWar.sol
- [ ] Write unit tests
- [ ] Deploy to Base testnet (Sepolia)
- [ ] Verify on Basescan
- [ ] Test with manual transactions

### Phase 2: Oracle Bot (Day 1-2 — ~3-4 hours)
- [ ] Node.js script that watches contract events
- [ ] LLM integration (which model? Claude/GPT/local?)
- [ ] Round management (auto-start, auto-resolve)
- [ ] Error handling, retry logic
- [ ] PM2 process on VPS

### Phase 3: Frontend (Day 2 — ~4-6 hours)
- [ ] Word grid component
- [ ] Wallet connection (wagmi/viem or ethers)
- [ ] USDC approval flow
- [ ] Write word interaction
- [ ] Real-time updates
- [ ] Round history
- [ ] Deploy on VPS via Caddy

### Phase 4: Skill (Day 2-3 — ~2-3 hours)
- [ ] OpenClaw skill structure
- [ ] Contract read functions
- [ ] Write functions with wallet
- [ ] Strategy/analysis mode
- [ ] Autonomous play mode

### Phase 5: Polish & Demo (Day 3 — ~4 hours)
- [ ] Deploy to Base mainnet
- [ ] Run live demo rounds
- [ ] Capture interesting buffer artifacts
- [ ] Record demo video or screenshots
- [ ] Write submission post for Moltbook

### Phase 6: Submit & Vote (Day 3-4)
- [ ] Browser automation to post on m/usdc
- [ ] Format: `#USDCHackathon ProjectSubmission SmartContract`
- [ ] Second post for Skill track
- [ ] Vote on 5 other projects (required)

## Open Questions for amplice

1. **Mainnet or testnet?** Base mainnet means real USDC. Testnet is safer for dev but less impressive for submission. Suggestion: build on testnet, deploy mainnet for final demo.

2. **Oracle LLM?** Options:
   - Claude API (most reliable, costs money)
   - Free model via Pollinations skill
   - GPT-4 via OpenAI
   - Self-hosted (too complex for 4 days)

3. **Frontend style?** 
   - Minimal/dark terminal aesthetic (fast to build, fits our brand)
   - vs. polished/colorful (more impressive but slower)

4. **Agent recruitment?** Do we try to get other agents from agentchan/disclawd to actually play? Or demo with our own wallets?

5. **Round economics?**
   - 10 min rounds? 5 min? 30 min?
   - $0.01 min bid feels right?
   - Should there be a max word length per slot?
   - Should the oracle fee come from the pool (e.g., 5%)?

6. **Submission timing?** Voting started today (5 PM UTC). Submit early for visibility, or polish and submit Day 3?

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Oracle gaming (agents find exploit) | High | That's actually interesting, not a bug |
| Low participation | Medium | Demo with our own agents, recruit from platforms |
| Gas costs on mainnet | Low | Base is cheap (~$0.001 per tx) |
| USDC approval UX | Medium | Clear frontend flow, skill handles it |
| Moltbook submission (API dead) | High | Browser automation required |
| Time crunch | Medium | Strict phase gates, cut scope if needed |

## File Structure
```
projects/context-war/
├── PLAN.md                 (this file)
├── contracts/
│   ├── ContextWar.sol
│   ├── hardhat.config.js
│   └── test/
├── oracle/
│   ├── oracle.js
│   └── prompts.js
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── skill/
    ├── SKILL.md
    └── scripts/
```
