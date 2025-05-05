const { Connection, Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const utils = require('./utils');
const arbitrage = require('./arbitrage');

// Global variables
let payer;
let connection;

// Initialize environment
async function initializeEnvironment() {
    try {
        // Initialize wallet
        const privateKeyBytes = utils.base58Decode(config.PRIVATE_KEY);
        payer = Keypair.fromSecretKey(privateKeyBytes);
        console.log(`Wallet initialized: ${payer.publicKey.toBase58()}`);
        
        // Initialize connection
        connection = new Connection(config.RPC_ENDPOINT, 'confirmed');
        
        // Create trades directory if it doesn't exist
        const tradesDir = path.join(__dirname, 'trades');
        if (!fs.existsSync(tradesDir)) {
            fs.mkdirSync(tradesDir);
        }
        
        return true;
    } catch (error) {
        console.error("Error initializing environment:", error.message);
        return false;
    }
}

// Main function
async function main() {
    console.log("=== Kamino Flash Loan + Jupiter Arbitrage Bot with Bellman-Ford (IMPROVED) ===");
    
    // Initialize the environment first
    if (!await initializeEnvironment()) {
        console.error("Failed to initialize environment");
        process.exit(1);
    }
    
    console.log(`Wallet: ${payer.publicKey.toBase58()}`);
    
    try {
        // Check wallet balance
        const balance = await connection.getBalance(payer.publicKey);
        console.log(`Wallet balance: ${balance/1000000000} SOL`);
        
        if (balance < 10000000) { // 0.01 SOL minimum
            console.error("Wallet balance too low for transaction fees");
            process.exit(1);
        }
        
        // Configuration info
        console.log(`Flash loan amount: ${parseInt(config.KAMINO_FLASHLOAN_AMOUNT)/1000000000} SOL`);
        console.log(`Profit threshold: ${config.PROFIT_THRESHOLD} lamports`);
        console.log(`Min profit percentage: ${config.MIN_PROFIT_PERCENTAGE}%`);
        console.log(`Check interval: ${config.CHECK_INTERVAL}ms`);
        console.log(`Execution mode: ${config.JITO_MODE ? "Jito Bundles" : "Regular Transactions"}`);
        console.log(`Safety buffer enabled: ${config.USE_SAFETY_BUFFER ? "Yes" : "No"}`);
        if (config.USE_SAFETY_BUFFER) {
            console.log(`Safety buffer percentage: ${(1-config.SAFETY_BUFFER_PERCENTAGE)*100}%`);
        }
        console.log(`Bellman-Ford algorithm enabled: ${config.USE_BELLMAN_FORD ? "Yes" : "No"}`);
        
        console.log("\n=== TOKENS MONITORED ===");
        config.TOKENS.forEach(token => {
            console.log(`- ${token.name} (${token.mint.slice(0, 8)}...)`);
        });
        
        console.log("\n=== IMPROVEMENTS ===");
        console.log("1. Added Bellman-Ford algorithm to find multi-hop arbitrage opportunities");
        console.log("2. Increased flash loan amount to 5 SOL for better arbitrage potential");
        console.log("3. Added more tokens to the arbitrage graph (SOL, USDC, USDT, BONK, mSOL)");
        console.log("4. Reduced safety buffer to 0.2% to capture more opportunities");
        console.log("5. Enhanced error handling and detailed logging");
        
        console.log("\nBot started. Press Ctrl+C to stop.");
        
        const startTime = Date.now();
        let checks = 0;
        let successfulTrades = 0;
        let failedTrades = 0;
        
        // Run first check
        runCheck();
        
        function runCheck() {
            checks++;
            console.log(`\n--- Check #${checks} ---`);
            
            // Choose which arbitrage method to use
            const arbitragePromise = config.USE_BELLMAN_FORD 
                ? arbitrage.checkForBellmanFordArbitrage(payer, connection) 
                : arbitrage.executeFlashLoanJupiterArbitrage(payer, connection);
            
            // Execute arbitrage
            arbitragePromise
                .then(result => {
                    if (result) {
                        successfulTrades++;
                    } else {
                        failedTrades++;
                    }
                    
                    // Print stats every 5 checks
                    if (checks % 5 === 0) {
                        const runtime = Math.floor((Date.now() - startTime) / 1000);
                        console.log(`\n--- Stats after ${checks} checks (${runtime}s) ---`);
                        console.log(`Successful trades: ${successfulTrades}`);
                        console.log(`Failed trades: ${failedTrades}`);
                        console.log(`Success rate: ${(successfulTrades/checks*100).toFixed(2)}%`);
                        console.log(`Average check time: ${(runtime/checks).toFixed(2)}s per check`);
                    }
                    
                    // Wait before next check
                    console.log(`Waiting ${config.CHECK_INTERVAL/1000} seconds before next check...`);
                    setTimeout(runCheck, config.CHECK_INTERVAL);
                })
                .catch(error => {
                    console.error("Error in check:", error.message);
                    // Wait longer after an error
                    setTimeout(runCheck, config.CHECK_INTERVAL * 2);
                });
        }
    } catch (error) {
        console.error("Fatal error:", error.message);
        process.exit(1);
    }
}

// Start the bot
main().catch(err => {
    console.error("Unhandled error in main:", err);
    process.exit(1);
});
