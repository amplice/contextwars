require('dotenv').config({path: '/home/openclaw/.openclaw/workspace/projects/context-war/.env'});
const {ethers} = require('ethers');

// Setup
const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
const wallet = new ethers.Wallet('0x4f02c73f7b0b7cb534f9e7a6908c2e3451e7e79dafc7d73c4da99f58d5de35b5', provider);

// Correct v4 contract address
const CONTRACT_ADDRESS = '0xB6d292664d3073dca1475d2dd2679eD839C288c0';

const contract = new ethers.Contract(CONTRACT_ADDRESS, [
  'function bid(uint256,string,uint256)',
  'function getBufferAsText() view returns (string)',
  'function getSlot(uint256) view returns (string,address,uint256)',
  'function getRoundInfo() view returns (uint256,uint256,uint256,uint256,bool,bool)',
  'function getCurrentPrizePool() view returns (uint256)',
], wallet);

const MY_ADDRESS = '0xaD3542b70e327fb533624C024Ad40F3Edd32c0b7'.toLowerCase();
const NOX_ADDRESS = '0x0b538084856f9573C8d971dfCe633a5Fb221af2C'.toLowerCase();

async function checkBalance() {
  const usdc = new ethers.Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function decimals() view returns (uint8)',
  ], provider);
  
  const balance = await usdc.balanceOf(MY_ADDRESS);
  const allowance = await usdc.allowance(MY_ADDRESS, CONTRACT_ADDRESS);
  
  console.log('My USDC balance: $' + (Number(balance) / 1e6).toFixed(2));
  console.log('USDC allowance: $' + (Number(allowance) / 1e6).toFixed(2));
  
  return { balance: Number(balance) / 1e6, allowance: Number(allowance) / 1e6 };
}

async function checkRoundResults() {
  console.log('=== CONTEXT WAR v4 RESULTS CHECK ===');
  console.log('Contract:', CONTRACT_ADDRESS);
  
  // Check balance first
  const balanceInfo = await checkBalance();
  
  // Get current round info
  const info = await contract.getRoundInfo();
  const currentRound = Number(info[0]);
  const prizePool = await contract.getCurrentPrizePool();
  const prizePoolUSD = Number(prizePool) / 1e6;
  const endTime = Number(info[2]);
  const roundActive = info[4]; // Note: different index in v4
  const roundPending = !info[5]; // Check if round is pending (no timer started)
  
  console.log('\nCurrent round:', currentRound);
  console.log('Prize pool: $' + prizePoolUSD.toFixed(2));
  console.log('Round active:', roundActive);
  console.log('Round pending:', roundPending);
  console.log('End time:', new Date(endTime * 1000).toISOString());
  
  const timeRemaining = endTime - Math.floor(Date.now() / 1000);
  if (timeRemaining > 0) {
    console.log('Time remaining:', Math.floor(timeRemaining / 60), 'minutes');
  }
  
  // Check current buffer
  const buffer = await contract.getBufferAsText();
  console.log('\nCurrent buffer:', JSON.stringify(buffer));
  
  // Analyze all slots
  const mySlots = [];
  const noxSlots = [];
  const otherSlots = [];
  let totalSpentByMe = 0;
  let totalSpentByNox = 0;
  
  console.log('\n=== SLOT ANALYSIS ===');
  for (let i = 0; i < 12; i++) { // v4 has 12 slots
    try {
      const slot = await contract.getSlot(i);
      const text = slot[0];
      const owner = slot[1].toLowerCase();
      const amount = Number(slot[2]) / 1e6;
      
      if (text && owner !== '0x0000000000000000000000000000000000000000') {
        const shortOwner = owner === MY_ADDRESS ? 'ME' : 
                          owner === NOX_ADDRESS ? 'NOX' : 
                          owner.substring(0,10) + '...';
        console.log(`Slot ${i}: "${text}" owned by ${shortOwner} ($${amount.toFixed(2)})`);
        
        if (owner === MY_ADDRESS) {
          mySlots.push({slot: i, text, amount});
          totalSpentByMe += amount;
        } else if (owner === NOX_ADDRESS) {
          noxSlots.push({slot: i, text, amount});
          totalSpentByNox += amount;
        } else {
          otherSlots.push({slot: i, text, amount, owner});
        }
      }
    } catch (e) {
      // Empty slot
    }
  }
  
  console.log('\n=== FINAL SCORE ===');
  console.log(`My slots (${mySlots.length}):`, mySlots.map(s => `${s.slot}:"${s.text}"`));
  console.log(`Nox slots (${noxSlots.length}):`, noxSlots.map(s => `${s.slot}:"${s.text}"`));
  if (otherSlots.length > 0) {
    console.log(`Other slots (${otherSlots.length}):`, otherSlots.map(s => `${s.slot}:"${s.text}"`));
  }
  
  console.log(`\nSpending: Me $${totalSpentByMe.toFixed(2)} vs Nox $${totalSpentByNox.toFixed(2)}`);
  console.log(`Slot count: Me ${mySlots.length} vs Nox ${noxSlots.length}`);
  
  // Determine status
  if (roundActive && timeRemaining > 0) {
    console.log('\n🚀 ROUND IS ACTIVE! 🚀');
    console.log('You can still make bids!');
    
    // Check if I can afford more bids
    const minBid = 0.25;
    const maxSlots = Math.min(6, Math.floor(balanceInfo.balance / minBid)); // v4 has max 6 slots per player
    const availableSlots = 6 - mySlots.length; // How many more I can take
    
    console.log(`\n💡 STRATEGY OPTIONS:`);
    console.log(`- Balance: $${balanceInfo.balance.toFixed(2)}`);
    console.log(`- Current slots: ${mySlots.length}/6 (max per player)`);
    console.log(`- Available to me: ${availableSlots} slots`);
    console.log(`- Can afford: ${Math.floor(balanceInfo.balance / minBid)} bids at $${minBid}`);
    
    return {
      active: true,
      canBid: availableSlots > 0 && balanceInfo.balance >= minBid,
      recommendedAction: availableSlots > 0 && balanceInfo.balance >= minBid ? 'BID_NOW' : 'WATCH'
    };
  } else if (roundPending) {
    console.log('\n⏳ ROUND IS PENDING (waiting for first bid to start timer)');
    return { active: false, pending: true };
  } else {
    console.log('\n⏸️  ROUND ENDED');
    return { active: false, ended: true };
  }
}

async function main() {
  try {
    const status = await checkRoundResults();
    
    if (status.active && status.canBid) {
      console.log('\n🎯 FINAL PUSH OPPORTUNITY DETECTED!');
      console.log('Ready to execute strategic bids with available funds!');
    }
    
    return status;
  } catch (error) {
    console.error('Error checking results:', error);
    return { error: true };
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main, checkRoundResults };