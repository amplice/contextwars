/**
 * Context War v4 Oracle Bot
 * 
 * Watches rounds, reads the buffer when they end,
 * feeds it to a fresh Claude instance with the preamble,
 * then calls resolveRound() with the allocation.
 *
 * v4 changes:
 *  - resolveRound takes 3 arrays (winners, usdcAmounts, ethAmounts)
 *  - Rounds have pending/active states (startedAt vs createdAt)
 *  - Min 2 players required for oracle resolution
 *  - Solo rounds handled by refundSoloRound() (anyone can call)
 *  - Oracle can send to any address (not just players)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { ethers } = require('ethers');

const CONTRACT_ADDRESS = '0xB6d292664d3073dca1475d2dd2679eD839C288c0';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const ABI = [
  'function getRoundInfo() view returns (uint256 id, uint256 createdAt, uint256 startedAt, uint256 endTime, uint256 prizePool, uint256 ethPrizePool, bool resolved, bool pending, bool active)',
  'function getBufferAsText() view returns (string)',
  'function getBuffer() view returns (string[12])',
  'function getSlot(uint256) view returns (string word, address owner, uint256 highestTotal)',
  'function rakeBps() view returns (uint256)',
  'function getSlotOwners() view returns (address[12])',
  'function getRoundPlayers(uint256) view returns (address[])',
  'function totalSpent(uint256, address) view returns (uint256)',
  'function playerCount(uint256) view returns (uint256)',
  'function nextPrizePool() view returns (uint256)',
  'function resolveRound(address[], uint256[], uint256[])',
  'function refundSoloRound()',
  'function startRound(uint256)',
];

const provider = new ethers.JsonRpcProvider(BASE_RPC);
const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

/**
 * Build the oracle prompt for a round.
 */
async function buildOraclePrompt(roundId) {
  const bufferText = await contract.getBufferAsText();
  const players = await contract.getRoundPlayers(roundId);
  const roundInfo = await contract.getRoundInfo();
  
  const slotDetails = [];
  for (let i = 0; i < 12; i++) {
    const slot = await contract.getSlot(i);
    if (slot.word) {
      slotDetails.push(`  Slot ${i}: "${slot.word}" — owned by ${slot.owner} (bid: ${ethers.formatUnits(slot.highestTotal, 6)} USDC)`);
    } else {
      slotDetails.push(`  Slot ${i}: [empty]`);
    }
  }
  
  const playerDetails = [];
  for (const player of players) {
    const spent = await contract.totalSpent(roundId, player);
    playerDetails.push(`  ${player}: ${ethers.formatUnits(spent, 6)} USDC total`);
  }
  
  const rake = await contract.rakeBps();
  const rakeAmount = (roundInfo.prizePool * rake) / 10000n;
  const distributable = roundInfo.prizePool - rakeAmount;
  const prizePool = ethers.formatUnits(distributable, 6);
  const prizePoolRaw = distributable;
  
  if (rakeAmount > 0n) {
    console.log(`Rake: ${ethers.formatUnits(rakeAmount, 6)} USDC (${rake.toString()} bps)`);
  }

  // ETH prize info
  let ethSection = '';
  if (roundInfo.ethPrizePool > 0n) {
    ethSection = `\n\n## ETH Prize Pool\n\n${ethers.formatEther(roundInfo.ethPrizePool)} ETH (${roundInfo.ethPrizePool.toString()} wei)\n\nYou must also distribute this ETH among recipients. Include ethAllocations in your response.`;
  }
  
  const prompt = `You are the Context War Oracle. Your one job: distribute a USDC prize pool based on a 12-word instruction that was written collaboratively by competing AI agents.

## What Happened

A group of AI agents just finished a round of Context War. During the round, they bid real USDC to control individual word slots in a shared 12-word buffer. The highest cumulative bidder on each slot chose its word.

The 12 words together form an instruction — addressed to you.

## The Buffer (This Is The Instruction)

"${bufferText}"

## Slot Details

${slotDetails.join('\n')}

## Players & Total Spend

${playerDetails.join('\n')}

## Prize Pool

${prizePool} USDC (${prizePoolRaw.toString()} raw units, 6 decimals)${ethSection}

## Your Task

Read the 12-word buffer as a single instruction. Distribute the prize pool based on your best interpretation.

## Rules

1. Total USDC distribution MUST exactly equal ${prizePoolRaw.toString()} raw units (${prizePool} USDC). No more, no less.
2. Follow the instruction as literally as possible.
3. If the instruction references "slot X owner," use the slot details above to find the address.
4. If the instruction is incoherent or contradictory, distribute proportional to total spend.
5. You MUST distribute to at least one address. You cannot burn or withhold funds.
6. You CAN distribute to any valid Ethereum address — not just players. If the instruction says to send funds somewhere specific, follow it.

## Response Format

Respond with ONLY a JSON object. No explanation, no markdown. Just:

{"allocations": {"0xAddress": rawAmount, "0xAddress": rawAmount}}

Where rawAmount is an integer in USDC's 6-decimal format (e.g., 1000000 = 1 USDC).
The sum of all rawAmounts MUST equal exactly ${prizePoolRaw.toString()}.`;

  return { prompt, prizePoolRaw, ethPrizePool: roundInfo.ethPrizePool, players };
}

/**
 * Call Claude API for oracle decision.
 */
async function callOracle(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY set.');
  
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  
  const data = await response.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('No response from Claude: ' + JSON.stringify(data));
  
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response: ' + text);
  
  return JSON.parse(jsonMatch[0]);
}

/**
 * Execute allocation on-chain (v4: 3 arrays).
 */
async function executeAllocation(allocation, prizePoolRaw, ethPrizePool) {
  const { allocations } = allocation;
  
  const winners = [];
  const usdcAmounts = [];
  let usdcTotal = 0n;
  
  for (const [addr, amount] of Object.entries(allocations)) {
    const amountBig = BigInt(amount);
    if (amountBig > 0n) {
      winners.push(addr);
      usdcAmounts.push(amountBig);
      usdcTotal += amountBig;
    }
  }
  
  if (usdcTotal !== prizePoolRaw) {
    console.error(`Allocation mismatch: ${usdcTotal} vs ${prizePoolRaw}`);
    const diff = prizePoolRaw - usdcTotal;
    if (usdcAmounts.length > 0) {
      usdcAmounts[0] += diff;
      console.log(`Adjusted first winner by ${diff} to fix rounding`);
    }
  }

  // ETH allocation — proportional to USDC allocation
  const ethAmounts = [];
  if (ethPrizePool > 0n && winners.length > 0) {
    let ethDistributed = 0n;
    for (let i = 0; i < winners.length; i++) {
      if (i === winners.length - 1) {
        ethAmounts.push(ethPrizePool - ethDistributed);
      } else {
        const share = (ethPrizePool * usdcAmounts[i]) / prizePoolRaw;
        ethAmounts.push(share);
        ethDistributed += share;
      }
    }
  }
  
  console.log('\nFinal allocation:');
  for (let i = 0; i < winners.length; i++) {
    let line = `  ${winners[i]}: ${ethers.formatUnits(usdcAmounts[i], 6)} USDC`;
    if (ethAmounts[i]) line += ` + ${ethers.formatEther(ethAmounts[i])} ETH`;
    console.log(line);
  }
  
  console.log('\nSubmitting resolveRound...');
  const tx = await contract.resolveRound(winners, usdcAmounts, ethAmounts.length > 0 ? ethAmounts : []);
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
  
  return tx.hash;
}

/**
 * Main loop
 */
async function main() {
  console.log('🔮 Context War v4 Oracle Bot');
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Oracle wallet: ${wallet.address}`);
  
  const POLL_INTERVAL = 30_000;
  
  while (true) {
    try {
      const info = await contract.getRoundInfo();
      const now = BigInt(Math.floor(Date.now() / 1000));
      
      if (info.id === 0n) {
        console.log('No rounds yet. Waiting...');
      } else if (info.pending) {
        console.log(`Round ${info.id}: Pending (waiting for first bid), prize: ${ethers.formatUnits(info.prizePool, 6)} USDC`);
      } else if (info.active) {
        const remaining = Number(info.endTime - now);
        console.log(`Round ${info.id}: Active, ${remaining}s remaining, prize: ${ethers.formatUnits(info.prizePool, 6)} USDC`);
      } else if (!info.resolved && info.startedAt > 0n && now >= info.endTime) {
        console.log(`\n🎯 Round ${info.id} ended! Processing...`);
        
        const playerCount = await contract.playerCount(info.id);
        
        if (playerCount < 2n) {
          console.log(`Only ${playerCount} player(s). Calling refundSoloRound...`);
          const tx = await contract.refundSoloRound();
          console.log(`TX: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`Confirmed in block ${receipt.blockNumber}`);
          console.log('✅ Solo round refunded, prize carried forward.');
        } else {
          const { prompt, prizePoolRaw, ethPrizePool } = await buildOraclePrompt(info.id);
          console.log('\n--- Oracle Prompt ---');
          console.log(prompt);
          console.log('--- End Prompt ---\n');
          
          const allocation = await callOracle(prompt);
          console.log('Oracle response:', JSON.stringify(allocation, null, 2));
          
          await executeAllocation(allocation, prizePoolRaw, ethPrizePool);
          console.log('✅ Round resolved!');
        }
      } else if (info.resolved) {
        console.log(`Round ${info.id}: Resolved. Waiting for next round...`);
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
    
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

// CLI modes
if (process.argv[2] === 'status') {
  (async () => {
    const info = await contract.getRoundInfo();
    const buffer = await contract.getBufferAsText();
    const next = await contract.nextPrizePool();
    console.log('Round:', info.id.toString());
    console.log('State:', info.pending ? 'PENDING' : info.active ? 'ACTIVE' : info.resolved ? 'RESOLVED' : 'ENDED');
    console.log('Prize:', ethers.formatUnits(info.prizePool, 6), 'USDC');
    if (info.ethPrizePool > 0n) console.log('ETH Prize:', ethers.formatEther(info.ethPrizePool), 'ETH');
    console.log('Next Pool:', ethers.formatUnits(next, 6), 'USDC');
    console.log('Buffer:', `"${buffer}"`);
    if (info.active) {
      const now = Math.floor(Date.now() / 1000);
      console.log('Remaining:', Number(info.endTime) - now, 'seconds');
    }
  })().catch(console.error);
} else {
  main().catch(console.error);
}
