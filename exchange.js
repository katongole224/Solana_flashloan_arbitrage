const { 
    PublicKey, 
    TransactionMessage, 
    VersionedTransaction, 
    Transaction,
    ComputeBudgetProgram 
} = require('@solana/web3.js');
const axios = require('axios');
const config = require('./config');
const utils = require('./utils');

const exchanges = {
    getJupiterQuote: async function(inputMint, outputMint, amount, connection, retryCount = 0, onlyDirectRoutes = false) {
        try {
            await utils.enforceRequestRateLimit();
            
            const slippageBps = "100";
            
            const params = {
                inputMint,
                outputMint,
                amount: amount ? amount.toString() : "0",
                slippageBps: slippageBps,
                onlyDirectRoutes: onlyDirectRoutes, // Support direct routes option
                maxAccounts: onlyDirectRoutes ? "10" : "30", // Reduce max accounts for direct routes
                platformFeeBps: "0"
            };
            
            const response = await axios.get(`${config.JUPITER_API_URL}/quote`, { params });
            
            // Simple logging of full response for debugging
            if (config.DEV_MODE) {
                console.log("Full Jupiter quote response:", JSON.stringify(response.data, null, 2));
            }
            
            // Try to extract route information
            const routePlan = response.data.routePlan || [];
            
            // Check if route info exists in a different structure
            if (config.VERBOSE_DEBUG && routePlan.length === 0 && response.data.routesInfos) {
                console.log("Found routesInfos instead of routePlan");
            }
            
            // Just get market info however we can
            const marketInfos = [];
            
            // Try different potential locations for market/DEX info
            if (routePlan && routePlan.length > 0) {
                for (const step of routePlan) {
                    if (step && step.amm) {
                        marketInfos.push(step.amm.label || step.amm.id || "Jupiter DEX");
                    } else if (step && step.marketInfos) {
                        // Some versions might have marketInfos directly
                        for (const market of step.marketInfos) {
                            marketInfos.push(market.label || market.id || "Jupiter DEX");
                        }
                    }
                }
            } else if (response.data.routesInfos && response.data.routesInfos.length > 0) {
                // Alternative location in some API versions
                const routeInfo = response.data.routesInfos[0];
                if (routeInfo && routeInfo.marketInfos) {
                    for (const market of routeInfo.marketInfos) {
                        marketInfos.push(market.label || market.id || "Jupiter DEX");
                    }
                }
            }
            
            // If we still don't have market info, just use "Jupiter"
            const dexNames = marketInfos.length > 0 ? marketInfos.join(', ') : "Jupiter";
            
            if (config.DEBUG_MODE) {
                console.log(`Got Jupiter quote: ${inputMint} -> ${outputMint}, Amount: ${amount}, Expected out: ${response.data.outAmount}`);
                console.log(`Route type: ${onlyDirectRoutes ? 'direct only' : 'any'}, Route steps: ${routePlan.length || 1}`);
                console.log(`DEXs used: ${dexNames}`);
            }
            
            // Add the extracted DEX information to the response
            response.data.dexNames = dexNames;
            response.data.routePlan = routePlan;
            
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 429 && retryCount < config.MAX_RETRIES) {
                console.log(`Rate limited, retrying in ${config.RETRY_DELAY_BASE * Math.pow(2, retryCount)/1000} seconds... (${retryCount+1}/${config.MAX_RETRIES})`);
                await utils.sleep(config.RETRY_DELAY_BASE * Math.pow(2, retryCount));
                return exchanges.getJupiterQuote(inputMint, outputMint, amount, connection, retryCount + 1, onlyDirectRoutes);
            }
            
            console.error(`Error getting quote for ${inputMint} -> ${outputMint}:`, error.message);
            return null;
        }
    },
    
    getSwapInstructions: async function(quote, payer, retryCount = 0) {
        try {
            await utils.enforceRequestRateLimit();
            
            const payload = {
                userPublicKey: payer.publicKey.toBase58(),
                wrapAndUnwrapSol: false,
                useSharedAccounts: true, // Use shared accounts to reduce size
                computeUnitPriceMicroLamports: 5000,
                dynamicComputeUnitLimit: true,
                quoteResponse: quote
            };
            
            const response = await axios.post(`${config.JUPITER_API_URL}/swap-instructions`, payload);
            
            if (config.VERBOSE_DEBUG) {
                console.log(`Swap instructions received for quote ${quote.inputMint} → ${quote.outputMint}`);
                
                if (config.DEV_MODE) {
                    // Only log in DEV_MODE to avoid cluttering
                    const setupCount = response.data.setupInstructions ? response.data.setupInstructions.length : 0;
                    const cleanupCount = response.data.cleanupInstruction ? 1 : 0;
                    console.log(`  Setup instructions: ${setupCount}`);
                    console.log(`  Cleanup instructions: ${cleanupCount}`);
                    
                    if (response.data.swapInstruction) {
                        const swapProgramId = response.data.swapInstruction.programId;
                        console.log(`  Swap through program: ${swapProgramId}`);
                    }
                }
            }
            
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 429 && retryCount < config.MAX_RETRIES) {
                console.log(`Rate limited, retrying in ${config.RETRY_DELAY_BASE * Math.pow(2, retryCount)/1000} seconds... (${retryCount+1}/${config.MAX_RETRIES})`);
                await utils.sleep(config.RETRY_DELAY_BASE * Math.pow(2, retryCount));
                return exchanges.getSwapInstructions(quote, payer, retryCount + 1);
            }
            
            console.error("Error getting swap instructions:", error.message);
            if (error.response) {
                console.error("API response:", error.response.data);
            }
            return null;
        }
    },
    
    /**
     * Gets simplified swap instructions with minimal size
     * Strips out unnecessary instructions to reduce transaction size
     */
    getSimplifiedSwapInstructions: async function(quote, payer, simplify = true, retryCount = 0) {
        try {
            await utils.enforceRequestRateLimit();
            
            const payload = {
                userPublicKey: payer.publicKey.toBase58(),
                wrapAndUnwrapSol: false,
                useSharedAccounts: true, // Use shared accounts to reduce size
                computeUnitPriceMicroLamports: 0, // We'll set this separately
                // Skip setting compute unit limit here as we'll set it separately
                quoteResponse: quote
            };
            
            const response = await axios.post(`${config.JUPITER_API_URL}/swap-instructions`, payload);
            
            if (!response.data) {
                console.error("No data in swap instructions response");
                return null;
            }
            
            // Extract swap instruction program ID for logging
            let swapProgramId = null;
            if (response.data.swapInstruction && response.data.swapInstruction.programId) {
                swapProgramId = response.data.swapInstruction.programId;
                
                if (config.VERBOSE_DEBUG) {
                    console.log(`Swap instruction program: ${swapProgramId}`);
                }
            }
            
            // Extract only what we need
            const result = {
                swapInstruction: response.data.swapInstruction,
                swapProgramId: swapProgramId
            };
            
            // Only include setup instructions if absolutely necessary
            if (!simplify && response.data.setupInstructions && response.data.setupInstructions.length > 0) {
                result.setupInstructions = response.data.setupInstructions;
            }
            
            // Skip cleanup instructions entirely to save space
            
            return result;
        } catch (error) {
            if (error.response && error.response.status === 429 && retryCount < config.MAX_RETRIES) {
                console.log(`Rate limited, retrying in ${config.RETRY_DELAY_BASE * Math.pow(2, retryCount)/1000} seconds... (${retryCount+1}/${config.MAX_RETRIES})`);
                await utils.sleep(config.RETRY_DELAY_BASE * Math.pow(2, retryCount));
                return exchanges.getSimplifiedSwapInstructions(quote, payer, simplify, retryCount + 1);
            }
            
            console.error("Error getting simplified swap instructions:", error.message);
            if (error.response) {
                console.error("API response:", error.response.data);
            }
            return null;
        }
    },
    
    getSwapInstructionsWithCustomAmount: async function(quote, customAmount, payer, retryCount = 0) {
        try {
            await utils.enforceRequestRateLimit();
            
            const modifiedQuote = { ...quote };
            modifiedQuote.inAmount = customAmount.toString();
            
            const newQuote = await exchanges.getJupiterQuote(
                modifiedQuote.inputMint, 
                modifiedQuote.outputMint, 
                customAmount
            );
            
            if (!newQuote) {
                console.error("Failed to get quote with custom amount");
                return null;
            }
            
            return exchanges.getSwapInstructions(newQuote, payer, retryCount);
        } catch (error) {
            console.error("Error getting swap instructions with custom amount:", error.message);
            return null;
        }
    },
    
    /**
     * Get a complete swap transaction with instruction
     * @param {Object} quote Jupiter quote
     * @param {Keypair} payer Signer
     * @param {Connection} connection Solana connection
     * @param {boolean} useALT Whether to use address lookup tables
     * @param {Array} lookupTables Address lookup tables
     * @returns {Promise<Transaction|VersionedTransaction>} Swap transaction
     */
    getSwapTransaction: async function(quote, payer, connection, useALT = false, lookupTables = [], retryCount = 0) {
        try {
            await utils.enforceRequestRateLimit();
            
            // First get the swap instructions
            const swapInstructions = await exchanges.getSwapInstructions(quote, payer);
            if (!swapInstructions) {
                console.error("Failed to get swap instructions");
                return null;
            }
            
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            
            if (useALT && lookupTables && lookupTables.length > 0) {
                // Create a versioned transaction with ALTs
                // Compile instructions
                const instructions = [];
                
                // Add compute budget instructions
                instructions.push(
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: 20000
                    })
                );
                
                instructions.push(
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: 300000
                    })
                );
                
                // Add setup instructions if any
                if (swapInstructions.setupInstructions && swapInstructions.setupInstructions.length > 0) {
                    for (const instruction of swapInstructions.setupInstructions) {
                        instructions.push(utils.simpleInstructionFormat(instruction));
                    }
                }
                
                // Add swap instruction
                instructions.push(utils.simpleInstructionFormat(swapInstructions.swapInstruction));
                
                // Add cleanup instructions if any
                if (swapInstructions.cleanupInstruction) {
                    instructions.push(utils.simpleInstructionFormat(swapInstructions.cleanupInstruction));
                }
                
                // Create v0 transaction message
                const messageV0 = new TransactionMessage({
                    payerKey: payer.publicKey,
                    recentBlockhash: blockhash,
                    instructions
                }).compileToV0Message(lookupTables);
                
                // Create versioned transaction
                const transaction = new VersionedTransaction(messageV0);
                
                // Check transaction size
                const serializedSize = transaction.serialize().length;
                console.log(`ALT swap transaction size: ${serializedSize} bytes (limit: 1232 bytes)`);
                
                if (serializedSize > 1232) {
                    console.error(`ALT swap transaction too large: ${serializedSize} > 1232 bytes`);
                    return null;
                }
                
                // Sign transaction
                transaction.sign([payer]);
                return transaction;
            } else {
                // Create a regular transaction
                const tx = new Transaction();
                tx.recentBlockhash = blockhash;
                tx.feePayer = payer.publicKey;
                
                // Add compute budget instructions
                tx.add(
                    ComputeBudgetProgram.setComputeUnitPrice({
                        microLamports: 20000
                    })
                );
                
                tx.add(
                    ComputeBudgetProgram.setComputeUnitLimit({
                        units: 300000
                    })
                );
                
                // Add setup instructions if any
                if (swapInstructions.setupInstructions && swapInstructions.setupInstructions.length > 0) {
                    for (const instruction of swapInstructions.setupInstructions) {
                        tx.add(utils.simpleInstructionFormat(instruction));
                    }
                }
                
                // Add swap instruction
                tx.add(utils.simpleInstructionFormat(swapInstructions.swapInstruction));
                
                // Add cleanup instructions if any
                if (swapInstructions.cleanupInstruction) {
                    tx.add(utils.simpleInstructionFormat(swapInstructions.cleanupInstruction));
                }
                
                // Check transaction size
                const serialized = tx.serialize({requireAllSignatures: false, verifySignatures: false});
                console.log(`Swap transaction size: ${serialized.length} bytes (limit: 1232 bytes)`);
                
                if (serialized.length > 1232) {
                    console.error(`Swap transaction too large: ${serialized.length} > 1232 bytes`);
                    return null;
                }
                
                // Sign transaction
                tx.sign(payer);
                return tx;
            }
        } catch (error) {
            if (error.response && error.response.status === 429 && retryCount < config.MAX_RETRIES) {
                console.log(`Rate limited, retrying in ${config.RETRY_DELAY_BASE * Math.pow(2, retryCount)/1000} seconds... (${retryCount+1}/${config.MAX_RETRIES})`);
                await utils.sleep(config.RETRY_DELAY_BASE * Math.pow(2, retryCount));
                return exchanges.getSwapTransaction(quote, payer, connection, useALT, lookupTables, retryCount + 1);
            }
            
            console.error("Error creating swap transaction:", error.message);
            return null;
        }
    },
    
    fetchLookupTables: async function(connection) {
        // Define lookup table addresses
        const lookupTableAddresses = [
            "8HvgxVyd22Jq9mmoojm4Awqw6sbymbF5pwLr8FtvySHs",
            "4sKLJ1Qoudh8PJyqBeuKocYdsZvxTcRShUt9aKqwhgvC"
        ];
        
        try {
            const results = [];
            
            for (const address of lookupTableAddresses) {
                try {
                    console.log(`Fetching lookup table: ${address}`);
                    const lookupTableAddress = new PublicKey(address);
                    const lookupTableResult = await connection.getAddressLookupTable(lookupTableAddress);
                    
                    if (lookupTableResult && lookupTableResult.value) {
                        results.push(lookupTableResult.value);
                        console.log(`Successfully fetched lookup table: ${address} with ${lookupTableResult.value.state.addresses.length} addresses`);
                    } else {
                        console.log(`Lookup table not found: ${address}`);
                    }
                } catch (err) {
                    console.error(`Error fetching lookup table ${address}:`, err.message);
                    // Continue with other lookup tables if one fails
                }
            }
            
            console.log(`Successfully fetched ${results.length} lookup tables`);
            return results;
        } catch (error) {
            console.error("Error fetching lookup tables:", error.message);
            console.log("Continuing without lookup tables");
            return []; // Return empty array instead of null to avoid downstream issues
        }
    },
    
    // Enhanced Jito bundle submission function with better error handling
    submitJitoBundle: async function(transaction, tipAmount, payer, connection, retryCount = 0) {
        try {
            console.log(`Creating Jito bundle with tip of ${tipAmount} lamports...`);
            
            // Create tip transaction with enhanced error handling
            const tipTransaction = await utils.createJitoTipTransaction(tipAmount, payer, connection);
            if (!tipTransaction) {
                console.error("Failed to create tip transaction. Check JITO_TIP_ACCOUNT and connection.");
                
                // Check if the tip account is defined
                if (!config.JITO_TIP_ACCOUNT) {
                    console.error("JITO_TIP_ACCOUNT is not defined in config.js");
                    return {
                        success: false, 
                        error: "Failed to create tip transaction: JITO_TIP_ACCOUNT is not defined"
                    };
                }
                
                // Try to validate the tip account address
                try {
                    new PublicKey(config.JITO_TIP_ACCOUNT);
                } catch (err) {
                    console.error(`JITO_TIP_ACCOUNT (${config.JITO_TIP_ACCOUNT}) is not a valid Solana address`);
                    return {
                        success: false, 
                        error: `Failed to create tip transaction: Invalid JITO_TIP_ACCOUNT address: ${config.JITO_TIP_ACCOUNT}`
                    };
                }
                
                return {
                    success: false, 
                    error: "Failed to create tip transaction"
                };
            }
            
            // Serialize transactions and encode for Jito API
            let serializedTx, serializedTip, encodedTx, encodedTip;
            try {
                serializedTx = transaction.serialize();
                serializedTip = tipTransaction.serialize();
                
                encodedTx = utils.base58Encode(serializedTx);
                encodedTip = utils.base58Encode(serializedTip);
                
                console.log(`Serialized main transaction: ${serializedTx.length} bytes`);
                console.log(`Serialized tip transaction: ${serializedTip.length} bytes`);
            } catch (error) {
                console.error("Error serializing transactions:", error.message);
                return {
                    success: false,
                    error: `Failed to serialize transactions: ${error.message}`
                };
            }
            
            const payload = {
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [[encodedTx, encodedTip]]
            };
            
            console.log(`Submitting bundle to Jito Block Engine: ${config.JITO_BLOCK_ENGINE_URL}`);
            let response;
            try {
                response = await axios.post(config.JITO_BLOCK_ENGINE_URL, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: config.JITO_BUNDLE_TIMEOUT || 10000 // 10 second timeout for Jito API
                });
            } catch (error) {
                console.error("Error making request to Jito Block Engine:", error.message);
                
                // Handle specific error types for better debugging
                if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
                    console.error(`Could not connect to Jito Block Engine at ${config.JITO_BLOCK_ENGINE_URL}. Check URL and network connection.`);
                    return {
                        success: false,
                        error: `Could not connect to Jito Block Engine: ${error.message}`
                    };
                }
                
                if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
                    console.error(`Connection to Jito Block Engine timed out after ${config.JITO_BUNDLE_TIMEOUT || 10000}ms`);
                    // This is a retry-able error
                    if (retryCount < (config.JITO_MAX_RETRIES || config.MAX_RETRIES)) {
                        const delay = config.RETRY_DELAY_BASE * Math.pow(2, retryCount);
                        console.log(`Retrying Jito bundle submission in ${delay/1000} seconds... (${retryCount+1}/${config.JITO_MAX_RETRIES || config.MAX_RETRIES})`);
                        await utils.sleep(delay);
                        
                        return exchanges.submitJitoBundle(transaction, tipAmount, payer, connection, retryCount + 1);
                    }
                }
                
                let errorDetail = error.message;
                if (error.response && error.response.data) {
                    errorDetail = `${error.message}: ${JSON.stringify(error.response.data)}`;
                    console.error("Response error data:", error.response.data);
                }
                
                return {
                    success: false,
                    error: errorDetail
                };
            }
            
            // Process the response
            if (response && response.data) {
                if (response.data.result) {
                    const bundleId = response.data.result;
                    console.log(`Bundle submitted successfully! ID: ${bundleId}`);
                    console.log(`View on Jito Explorer: https://explorer.jito.wtf/bundle/${bundleId}`);
                    
                    return {
                        success: true,
                        bundleId: bundleId
                    };
                } else if (response.data.error) {
                    console.error("Error from Jito Block Engine:", response.data.error);
                    return {
                        success: false,
                        error: `Jito Error: ${response.data.error.message || JSON.stringify(response.data.error)}`
                    };
                } else {
                    console.error("Unknown response format from Jito Block Engine:", response.data);
                    return {
                        success: false,
                        error: "Unknown response format from Jito Block Engine"
                    };
                }
            } else {
                console.error("No data in response from Jito Block Engine");
                return {
                    success: false,
                    error: "No data in response from Jito Block Engine"
                };
            }
        } catch (error) {
            console.error("Unexpected error in submitJitoBundle:", error.message);
            if (error.stack) {
                console.error("Error stack:", error.stack);
            }
            
            // Retry logic for any other unexpected errors
            if (retryCount < (config.JITO_MAX_RETRIES || config.MAX_RETRIES)) {
                const delay = config.RETRY_DELAY_BASE * Math.pow(2, retryCount);
                console.log(`Retrying Jito bundle submission in ${delay/1000} seconds... (${retryCount+1}/${config.JITO_MAX_RETRIES || config.MAX_RETRIES})`);
                await utils.sleep(delay);
                
                return exchanges.submitJitoBundle(transaction, tipAmount, payer, connection, retryCount + 1);
            }
            
            return {
                success: false,
                error: `Unexpected error: ${error.message}`
            };
        }
    },
    
    getTokenBalance: async function(tokenAccountAddress, connection) {
        try {
            const accountInfo = await connection.getTokenAccountBalance(
                new PublicKey(tokenAccountAddress)
            );
            return parseInt(accountInfo.value.amount);
        } catch (error) {
            console.error(`Error getting token balance: ${error.message}`);
            return null;
        }
    },
    
    // Improved token account creation with retry logic and RPC fallback
    ensureTokenAccount: async function(mint, payer, connection, retryCount = 0) {
        try {
            const mintPubkey = mint instanceof PublicKey ? mint : new PublicKey(mint);
            const walletPubkey = payer.publicKey;
            
            const tokenAccount = utils.getAssociatedTokenAddress(mintPubkey, walletPubkey);
            
            // Check if account exists
            try {
                const accountInfo = await connection.getAccountInfo(tokenAccount);
                
                if (accountInfo) {
                    console.log(`Token account ${tokenAccount.toBase58()} already exists`);
                    return { exists: true, pubkey: tokenAccount };
                }
            } catch (error) {
                // If there's an error checking the account, we'll try to create it anyway
                console.log(`Error checking token account, attempting to create: ${error.message}`);
            }
            
            console.log(`Creating token account for mint ${mintPubkey.toBase58()}...`);
            
            try {
                const instruction = utils.createAssociatedTokenAccountInstruction(walletPubkey, mintPubkey, payer);
                
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                const messageV0 = new TransactionMessage({
                    payerKey: walletPubkey,
                    recentBlockhash: blockhash,
                    instructions: [instruction],
                }).compileToV0Message([]);
                
                const transaction = new VersionedTransaction(messageV0);
                transaction.sign([payer]);
                
                // Try with skipped preflight to avoid some RPC errors
                const signature = await connection.sendTransaction(transaction, {
                    skipPreflight: true,
                    preflightCommitment: 'confirmed',
                    maxRetries: 5
                });
                
                console.log(`Token account creation transaction sent: ${signature}`);
                
                // Wait a bit before checking confirmation
                await utils.sleep(2000);
                
                try {
                    const success = await utils.waitForConfirmation(signature, connection, 15);
                    
                    if (success) {
                        console.log(`Token account ${tokenAccount.toBase58()} created successfully`);
                        return { exists: false, pubkey: tokenAccount, created: true };
                    }
                } catch (confirmError) {
                    console.error(`Error confirming transaction: ${confirmError.message}`);
                }
                
                // Even if confirmation failed, check if the account exists now
                try {
                    const accountInfoAfterCreation = await connection.getAccountInfo(tokenAccount);
                    if (accountInfoAfterCreation) {
                        console.log(`Token account ${tokenAccount.toBase58()} exists after creation attempt`);
                        return { exists: true, pubkey: tokenAccount };
                    }
                } catch (checkError) {
                    console.error(`Error checking account after creation: ${checkError.message}`);
                }
            } catch (txError) {
                console.error(`Error creating token account: ${txError.message}`);
                
                // If it's not an "account already exists" error, retry
                if (txError.message.includes("already in use") ||
                    txError.message.includes("already exists")) {
                    console.log("Account already exists error, treating as success");
                    return { exists: true, pubkey: tokenAccount };
                }
            }
            
            // If we reach here with retries left, try again
            if (retryCount < 2) {
                console.log(`Retrying token account creation (${retryCount + 1}/2)...`);
                await utils.sleep(2000);
                return exchanges.ensureTokenAccount(mint, payer, connection, retryCount + 1);
            }
            
            // At this point we'll assume the account exists to avoid blocking arbitrage
            // This won't cause issues if the account doesn't exist as the transaction will fail later anyway
            console.log(`Using token account ${tokenAccount.toBase58()} despite errors`);
            return { exists: false, pubkey: tokenAccount, created: false, assumedValid: true };
            
        } catch (error) {
            console.error(`Error ensuring token account exists:`, error);
            
            // Return a sensible result that won't block execution
            const mintPubkey = mint instanceof PublicKey ? mint : new PublicKey(mint);
            const walletPubkey = payer.publicKey;
            const tokenAccount = utils.getAssociatedTokenAddress(mintPubkey, walletPubkey);
            
            if (retryCount < 2) {
                console.log(`Retrying token account creation (${retryCount + 1}/2)...`);
                await utils.sleep(2000);
                return exchanges.ensureTokenAccount(mint, payer, connection, retryCount + 1);
            }
            
            // Assume the account exists in last resort case
            console.log(`Assuming token account ${tokenAccount.toBase58()} exists despite errors`);
            return { exists: false, pubkey: tokenAccount, created: false, assumedValid: true };
        }
    }
};

module.exports = exchanges;
