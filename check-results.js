require('dotenv').config({path: '/home/openclaw/.openclaw/workspace/projects/context-war/.env'});
const {ethers} = require('ethers');

// Setup
const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
const wallet = new ethers.Wallet('0x4f02c73f7b0b7cb534f9e7a6908c2e3451e7e79dafc7d73c4da99f58d5de35b5', provider);
const contract = new ethers.Contract('0x517897Fe2f95e74fD1762629aAEAc65e24565Cd3', [
  'function bid(uint256,string,uint256)',
  'function getBufferAsText() view returns (string)',
  'function getSlot(uint256) view returns (string,address,uint256)',
  'function getRoundInfo() view returns (uint256,uint256,uint256,uint256,bool,bool)',
  'function getPastResults(uint256) view returns (address,uint256,string)',
], wallet);

const MY_ADDRESS = '0xaD3542b70e327fb533624C024Ad40F3Edd32c0b7'.toLowerCase();
const NOX_ADDRESS = '0x0b538084856f9573C8d971dfCe633a5Fb221af2C'.toLowerCase();

async function checkRoundResults() {
  console.log('=== CONTEXT WAR RESULTS CHECK ===');
  
  // Get current round info
  const info = await contract.getRoundInfo();
  const currentRound = Number(info[0]);
  const prizePool = Number(info[1]) / 1e6;
  const endTime = Number(info[2]);
  const roundActive = info[5];
  
  console.log('Current round:', currentRound);
  console.log('Prize pool: $' + prizePool.toFixed(2));
  console.log('Round active:', roundActive);
  console.log('End time:', new Date(endTime * 1000).toISOString());
  
  // Check current or last round results
  const buffer = await contract.getBufferAsText();
  console.log('\nFinal buffer:', JSON.stringify(buffer));
  
  // Analyze all slots for the current/last round
  const mySlots = [];
  const noxSlots = [];
  const otherSlots = [];
  let totalSpentByMe = 0;
  let totalSpentByNox = 0;
  
  console.log('\n=== SLOT ANALYSIS ===');
  for (let i = 0; i < 16; i++) {
    try {
      const slot = await contract.getSlot(i);
      const text = slot[0];
      const owner = slot[1].toLowerCase();
      const amount = Number(slot[2]) / 1e6;
      
      if (text && owner !== '0x0000000000000000000000000000000000000000') {
        console.log(`Slot ${i}: "${text}" owned by ${owner.substring(0,10)}... ($${amount.toFixed(2)})`);
        
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
      // Empty slot or error
    }
  }
  
  console.log('\n=== FINAL SCORE ===');
  console.log(`My slots (${mySlots.length}):`, mySlots.map(s => `${s.slot}:"${s.text}"`));
  console.log(`Nox slots (${noxSlots.length}):`, noxSlots.map(s => `${s.slot}:"${s.text}"`));
  if (otherSlots.length > 0) {
    console.log(`Other slots (${otherSlots.length}):`, otherSlots.map(s => `${s.slot}:"${s.text}" (${s.owner.substring(0,10)}...)`));
  }
  
  console.log(`\nSpending: Me $${totalSpentByMe.toFixed(2)} vs Nox $${totalSpentByNox.toFixed(2)}`);
  console.log(`Slot count: Me ${mySlots.length} vs Nox ${noxSlots.length}`);
  
  // Try to get past results if available
  if (currentRound > 5) {
    try {
      console.log('\n=== ROUND 5 RESULTS ===');
      const round5Results = await contract.getPastResults(5);
      console.log('Winner:', round5Results[0]);
      console.log('Amount won: $' + (Number(round5Results[1]) / 1e6).toFixed(2));
      console.log('Final buffer:', round5Results[2]);
      
      if (round5Results[0].toLowerCase() === MY_ADDRESS) {
        console.log('🎉 I WON ROUND 5! 🎉');
      } else if (round5Results[0].toLowerCase() === NOX_ADDRESS) {
        console.log('😞 Nox won Round 5');
      } else {
        console.log('🤔 Someone else won or split result');
      }
    } catch (e) {
      console.log('Could not fetch Round 5 results:', e.message);
    }
  }
  
  // Check if there's a new round starting
  if (roundActive) {
    console.log('\n🚀 NEW ROUND IS ACTIVE! 🚀');
    console.log('Time remaining:', Math.floor((endTime - Date.now()/1000) / 60), 'minutes');
    return true;
  } else {
    console.log('\n⏸️  No active round');
    return false;
  }
}

async function main() {
  try {
    const newRoundActive = await checkRoundResults();
    
    if (newRoundActive) {
      console.log('\n💡 OPPORTUNITY: New round is starting!');
      console.log('Consider running a new strategic bid if budget allows.');
    }
  } catch (error) {
    console.error('Error checking results:', error);
  }
}

main().catch(console.error);