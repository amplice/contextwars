#!/usr/bin/env node
/**
 * Context War — Game Status
 * Shows current round info, buffer contents, slot ownership, and player standings.
 */
const { ethers } = require('ethers');

const RPC = process.env.CONTEXT_WAR_RPC || process.env.BASE_RPC_URL || 'https://base-mainnet.public.blastapi.io';
const CONTRACT = process.env.CONTEXT_WAR_CONTRACT || '0x65688010c11Cbad24C83451407aFEa44eF71687e';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ABI = [
  'function getRoundInfo() view returns (uint256 id, uint256 startTime, uint256 endTime, uint256 prizePool, bool resolved, bool active)',
  'function getBufferAsText() view returns (string)',
  'function getSlot(uint256) view returns (string word, address owner, uint256 highestTotal)',
  'function getSlotOwners() view returns (address[12])',
  'function getRoundPlayers(uint256) view returns (address[])',
  'function totalSpent(uint256, address) view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(RPC);
const contract = new ethers.Contract(CONTRACT, ABI, provider);

(async () => {
  const info = await contract.getRoundInfo();
  const buffer = await contract.getBufferAsText();
  const now = Math.floor(Date.now() / 1000);

  console.log('═══════════════════════════════════════');
  console.log('  ⚔️  CONTEXT WAR — Round', info.id.toString());
  console.log('═══════════════════════════════════════');
  console.log();

  if (info.active) {
    const remaining = Number(info.endTime) - now;
    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    console.log(`⏱  Time remaining: ${min}m ${sec}s`);
  } else if (info.resolved) {
    console.log('✅  Round resolved');
  } else if (info.id > 0n) {
    console.log('⏳  Round ended — awaiting oracle resolution');
  } else {
    console.log('💤  No active round');
  }

  console.log(`💰  Prize pool: ${ethers.formatUnits(info.prizePool, 6)} USDC`);
  console.log();

  // Buffer
  console.log('📝  Buffer:');
  console.log(`  "${buffer}"`);
  console.log();

  // Slots
  console.log('📊  Slots:');
  const owners = new Map();
  for (let i = 0; i < 12; i++) {
    const slot = await contract.getSlot(i);
    const word = slot.word || '---';
    const ownerShort = slot.owner.slice(0, 6) + '...' + slot.owner.slice(-4);
    const bid = ethers.formatUnits(slot.highestTotal, 6);
    const empty = slot.owner === '0x0000000000000000000000000000000000000000';
    
    if (!empty) {
      const prev = owners.get(slot.owner) || { slots: 0, totalBid: 0n };
      prev.slots++;
      prev.totalBid += slot.highestTotal;
      owners.set(slot.owner, prev);
    }
    
    const marker = empty ? '  ' : '▌ ';
    console.log(`  ${marker}[${i.toString().padStart(2)}] ${word.padEnd(20)} ${empty ? '(empty)' : ownerShort + ' $' + bid}`);
  }
  console.log();

  // Players
  if (info.id > 0n) {
    const players = await contract.getRoundPlayers(info.id);
    if (players.length > 0) {
      console.log('👥  Players:');
      for (const player of players) {
        const spent = await contract.totalSpent(info.id, player);
        const pShort = player.slice(0, 6) + '...' + player.slice(-4);
        const pInfo = owners.get(player);
        const slots = pInfo ? pInfo.slots : 0;
        console.log(`  ${pShort}  spent: $${ethers.formatUnits(spent, 6)}  slots: ${slots}`);
      }
    }
  }

  console.log();
  console.log(`🔗  Contract: ${CONTRACT}`);
  console.log(`🌐  Base L2 | USDC: ${USDC}`);
})().catch(e => {
  console.error('Error:', e.shortMessage || e.message);
  process.exit(1);
});
