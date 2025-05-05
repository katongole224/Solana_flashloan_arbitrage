const fs = require('fs');
const path = require('path');
const { 
    PublicKey, 
    TransactionInstruction, 
    SystemProgram, 
    Transaction,
    AddressLookupTableProgram 
} = require('@solana/web3.js');
const BN = require('bn.js');
const config = require('./config');

// Base58 alphabet and map for encoding/decoding
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = {};
for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_MAP[ALPHABET.charAt(i)] = i;
}

// Rate limiting variables
let lastRequestTime = 0;
let requestCounter = 0;
let requestWindowStart = Date.now();
const REQUEST_LIMIT = 60; // Maximum requests per minute (adjust based on API provider limits)
const REQUEST_WINDOW = 60000; // 1 minute in milliseconds

const utils = {
    sleep: function(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
    
    base58Decode: function(encoded) {
        if (!encoded || encoded.length === 0) return new Uint8Array(0);
        
        const bytes = [0];
        for (let i = 0; i < encoded.length; i++) {
            const value = ALPHABET_MAP[encoded[i]];
            if (value === undefined) {
                throw new Error(`Non-base58 character: ${encoded[i]}`);
            }
            
            let carry = value;
            for (let j = 0; j < bytes.length; j++) {
                carry += bytes[j] * 58;
                bytes[j] = carry & 0xff;
                carry >>= 8;
            }
            
            while (carry > 0) {
                bytes.push(carry & 0xff);
                carry >>= 8;
            }
        }
        
        // Handle leading zeros
        for (let i = 0; i < encoded.length && encoded[i] === '1'; i++) {
            bytes.push(0);
        }
        
        return new Uint8Array(bytes.reverse());
    },
    
    base58Encode: function(buffer) {
        if (buffer.length === 0) return '';
        
        // Convert buffer to base58
        let digits = [0];
        for (let i = 0; i < buffer.length; i++) {
            for (let j = 0; j < digits.length; j++) {
                digits[j] <<= 8;
            }
            
            digits[0] += buffer[i];
            
            let carry = 0;
            for (let j = 0; j < digits.length; j++) {
                digits[j] += carry;
                carry = (digits[j] / 58) | 0;
                digits[j] %= 58;
            }
            
            while (carry) {
                digits.push(carry % 58);
                carry = (carry / 58) | 0;
            }
        }
        
        // Deal with leading zeros
        for (let i = 0; buffer[i] === 0 && i < buffer.length - 1; i++) {
            digits.push(0);
        }
        
        // Convert digits to base58 string
        let result = '';
        for (let i = digits.length - 1; i >= 0; i--) {
            result += ALPHABET[digits[i]];
        }
        
        return result;
    },
    
    saveTrade: function(data) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
            const filePath = path.join(__dirname, 'trades', `trade_${timestamp}.json`);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            console.log(`Trade data saved to ${filePath}`);
        } catch (error) {
            console.error("Error saving trade data:", error.message);
        }
    },
    
    logFailedTrade: function(data) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.-]/g, '_');
            const filePath = path.join(__dirname, 'trades', `failed_trade_${timestamp}.json`);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            console.log(`Failed trade data saved to ${filePath}`);
        } catch (error) {
            console.error("Error saving failed trade data:", error.message);
        }
    },
    
    // Improved rate limiting function with rolling window
    enforceRequestRateLimit: async function() {
        // Check if we need to reset the window
        const now = Date.now();
        if (now - requestWindowStart > REQUEST_WINDOW) {
            requestWindowStart = now;
            requestCounter = 0;
        }
        
        // Enforce minimum interval between requests
        const timeSinceLastRequest = now - lastRequestTime;
        if (timeSinceLastRequest < config.MIN_REQUEST_INTERVAL) {
            const waitTime = config.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            await utils.sleep(waitTime);
        }
        
        // Check if we've exceeded the rate limit for the current window
        if (requestCounter >= REQUEST_LIMIT) {
            const timeUntilWindowReset = REQUEST_WINDOW - (now - requestWindowStart);
            const waitTime = Math.max(timeUntilWindowReset, 1000); // Wait at least 1 second
            console.log(`Rate limit reached. Waiting ${waitTime/1000} seconds for window reset...`);
            await utils.sleep(waitTime);
            
            // Reset window after waiting
            requestWindowStart = Date.now();
            requestCounter = 0;
        }
        
        // Update tracking variables
        requestCounter++;
        lastRequestTime = Date.now();
    },
    
    // Simple instruction format for creating transaction instructions
    simpleInstructionFormat: function(instruction) {
        try {
            if (!instruction || !instruction.programId || !instruction.accounts) {
                console.error("Invalid instruction format:", instruction);
                throw new Error("Invalid instruction format");
            }
            
            // Create the programId PublicKey
            let programId;
            try {
                programId = new PublicKey(instruction.programId);
            } catch (error) {
                console.error("Invalid programId:", instruction.programId);
                throw new Error("Invalid programId");
            }
            
            // Format and validate the account keys
            const keys = [];
            for (const account of instruction.accounts) {
                if (!account || !account.pubkey) {
                    console.error("Invalid account:", account);
                    throw new Error("Invalid account in instruction");
                }
                
                let pubkey;
                try {
                    pubkey = new PublicKey(account.pubkey);
                } catch (error) {
                    console.error("Invalid pubkey:", account.pubkey);
                    throw new Error(`Invalid pubkey: ${account.pubkey}`);
                }
                
                keys.push({
                    pubkey: pubkey,
                    isSigner: !!account.isSigner,
                    isWritable: !!account.isWritable
                });
            }
            
            // Decode the data
            let data;
            try {
                data = Buffer.from(instruction.data, 'base64');
            } catch (error) {
                console.error("Invalid data:", instruction.data);
                throw new Error("Invalid data in instruction");
            }
            
            // Create and return the TransactionInstruction
            return new TransactionInstruction({
                programId,
                keys,
                data
            });
        } catch (error) {
            console.error("Error creating simple instruction:", error.message);
            throw error;
        }
    },
    
    instructionFormat: function(instruction) {
        try {
            if (!instruction || !instruction.programId || !instruction.accounts) {
                console.error("Invalid instruction format:", JSON.stringify(instruction));
                throw new Error("Invalid instruction format");
            }
            
            return {
                programId: new PublicKey(instruction.programId),
                keys: instruction.accounts.map(account => {
                    if (!account || !account.pubkey) {
                        console.error("Invalid account in instruction:", JSON.stringify(account));
                        throw new Error("Invalid account in instruction");
                    }
                    return {
                        pubkey: new PublicKey(account.pubkey),
                        isSigner: !!account.isSigner,
                        isWritable: !!account.isWritable
                    };
                }),
                data: Buffer.from(instruction.data, 'base64')
            };
        } catch (error) {
            console.error("Error formatting instruction:", error.message);
            throw error;
        }
    },
    
    // Create a flash loan instruction set that has both borrow and repay in the same transaction
    createFlashLoanInstructionSet: function(walletPubkey, tokenAccount, amount) {
        try {
            // Validate inputs
            if (!walletPubkey) {
                console.error("Missing walletPubkey in createFlashLoanInstructionSet");
                throw new Error("Missing walletPubkey");
            }
            
            if (!tokenAccount) {
                console.error("Missing tokenAccount in createFlashLoanInstructionSet");
                throw new Error("Missing tokenAccount");
            }
            
            if (!amount) {
                console.error("Missing amount in createFlashLoanInstructionSet");
                throw new Error("Missing amount");
            }
            
            // Ensure the PublicKey type for wallet
            const walletPublicKey = walletPubkey instanceof PublicKey ? walletPubkey : new PublicKey(walletPubkey);
            
            // Ensure the PublicKey type for tokenAccount
            let tokenPublicKey;
            if (typeof tokenAccount === 'string') {
                tokenPublicKey = new PublicKey(tokenAccount);
            } else if (tokenAccount instanceof PublicKey) {
                tokenPublicKey = tokenAccount;
            } else if (tokenAccount && tokenAccount.toBase58) {
                tokenPublicKey = tokenAccount;
            } else {
                console.error("Invalid tokenAccount:", tokenAccount);
                throw new Error("Invalid tokenAccount type");
            }
            
            // Convert amount to BN if it's not already
            const amountBN = typeof amount === 'string' ? new BN(amount) : new BN(amount.toString());
            
            console.log(`Creating flash loan instruction set for wallet: ${walletPublicKey.toBase58()}, token account: ${tokenPublicKey.toBase58()}, amount: ${amountBN.toString()}`);
            
            // Create the borrow instruction
            const borrowData = Buffer.from(config.FLASH_BORROW_RESERVE_LIQUIDITY_DISCRIMINATOR);
            const amountBuffer = Buffer.alloc(8);
            amountBN.toBuffer('le', 8).copy(amountBuffer);
            const borrowData_complete = Buffer.concat([borrowData, amountBuffer]);

            const borrowKeys = [
                { pubkey: walletPublicKey, isSigner: true, isWritable: true },
                { pubkey: config.KAMINO_LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE, isSigner: false, isWritable: true },
                { pubkey: config.WSOL_MINT, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE_LIQUIDITY, isSigner: false, isWritable: true },
                { pubkey: tokenPublicKey, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_SOL_FEE_RECEIVER, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_REFERRER_TOKEN_STATE, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_REFERRER_ACCOUNT, isSigner: false, isWritable: false },
                { pubkey: config.SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
                { pubkey: config.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ];

            const borrowIx = new TransactionInstruction({
                programId: config.KAMINO_LENDING_PROGRAM_ID,
                keys: borrowKeys,
                data: borrowData_complete
            });
            
            // Create the repay instruction - it will reference the borrow instruction by index
            const repayData = Buffer.from(config.FLASH_REPAY_RESERVE_LIQUIDITY_DISCRIMINATOR);
            const repayAmountBuffer = Buffer.alloc(8);
            amountBN.toBuffer('le', 8).copy(repayAmountBuffer);
            const borrowInstructionIndexBuffer = Buffer.alloc(1);
            
            // Account for compute budget instructions (2) before the borrow instruction
            borrowInstructionIndexBuffer.writeUInt8(2);  // FIXED: Change from 0 to 2
            
            const repayData_complete = Buffer.concat([repayData, repayAmountBuffer, borrowInstructionIndexBuffer]);
            
            const repayKeys = [
                { pubkey: walletPublicKey, isSigner: true, isWritable: true },
                { pubkey: config.KAMINO_LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE, isSigner: false, isWritable: true },
                { pubkey: config.WSOL_MINT, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE_LIQUIDITY, isSigner: false, isWritable: true },
                { pubkey: tokenPublicKey, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_SOL_FEE_RECEIVER, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_REFERRER_TOKEN_STATE, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_REFERRER_ACCOUNT, isSigner: false, isWritable: false },
                { pubkey: config.SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
                { pubkey: config.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ];

            const repayIx = new TransactionInstruction({
                programId: config.KAMINO_LENDING_PROGRAM_ID,
                keys: repayKeys,
                data: repayData_complete
            });
            
            return {
                borrowIx,
                repayIx
            };
        } catch (error) {
            console.error("Error creating flash loan instruction set:", error.message);
            throw error;
        }
    },
    
    createSimpleFlashBorrowInstruction: function(walletPubkey, destinationTokenAccount, amount) {
        try {
            // Validate inputs
            if (!walletPubkey) {
                console.error("Missing walletPubkey in createSimpleFlashBorrowInstruction");
                throw new Error("Missing walletPubkey");
            }
            
            if (!destinationTokenAccount) {
                console.error("Missing destinationTokenAccount in createSimpleFlashBorrowInstruction");
                throw new Error("Missing destinationTokenAccount");
            }
            
            if (!amount) {
                console.error("Missing amount in createSimpleFlashBorrowInstruction");
                throw new Error("Missing amount");
            }
            
            // Ensure the PublicKey type for wallet
            const walletPublicKey = walletPubkey instanceof PublicKey ? walletPubkey : new PublicKey(walletPubkey);
            
            // Ensure the PublicKey type for destinationTokenAccount
            let destinationTokenPublicKey;
            if (typeof destinationTokenAccount === 'string') {
                destinationTokenPublicKey = new PublicKey(destinationTokenAccount);
            } else if (destinationTokenAccount instanceof PublicKey) {
                destinationTokenPublicKey = destinationTokenAccount;
            } else if (destinationTokenAccount && destinationTokenAccount.toBase58) {
                destinationTokenPublicKey = destinationTokenAccount;
            } else {
                console.error("Invalid destinationTokenAccount:", destinationTokenAccount);
                throw new Error("Invalid destinationTokenAccount type");
            }
            
            // Convert amount to BN if it's not already
            const amountBN = typeof amount === 'string' ? new BN(amount) : new BN(amount.toString());
            
            console.log(`Creating simple flash borrow instruction for wallet: ${walletPublicKey.toBase58()}, destination: ${destinationTokenPublicKey.toBase58()}, amount: ${amountBN.toString()}`);
            
            const borrowData = Buffer.from(config.FLASH_BORROW_RESERVE_LIQUIDITY_DISCRIMINATOR);
            const amountBuffer = Buffer.alloc(8);
            amountBN.toBuffer('le', 8).copy(amountBuffer);
            const data = Buffer.concat([borrowData, amountBuffer]);

            const keys = [
                { pubkey: walletPublicKey, isSigner: true, isWritable: true },
                { pubkey: config.KAMINO_LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE, isSigner: false, isWritable: true },
                { pubkey: config.WSOL_MINT, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE_LIQUIDITY, isSigner: false, isWritable: true },
                { pubkey: destinationTokenPublicKey, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_SOL_FEE_RECEIVER, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_REFERRER_TOKEN_STATE, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_REFERRER_ACCOUNT, isSigner: false, isWritable: false },
                { pubkey: config.SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
                { pubkey: config.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ];

            return new TransactionInstruction({
                programId: config.KAMINO_LENDING_PROGRAM_ID,
                keys,
                data
            });
        } catch (error) {
            console.error("Error creating simple flash borrow instruction:", error.message);
            throw error;
        }
    },
    
    createSimpleFlashRepayInstruction: function(walletPubkey, sourceTokenAccount, amount, borrowTransactionId) {
        try {
            // Validate inputs
            if (!walletPubkey) {
                console.error("Missing walletPubkey in createSimpleFlashRepayInstruction");
                throw new Error("Missing walletPubkey");
            }
            
            if (!sourceTokenAccount) {
                console.error("Missing sourceTokenAccount in createSimpleFlashRepayInstruction");
                throw new Error("Missing sourceTokenAccount");
            }
            
            if (!amount) {
                console.error("Missing amount in createSimpleFlashRepayInstruction");
                throw new Error("Missing amount");
            }
            
            // For simple instructions, we don't need the borrowInstructionIndex since each transaction is separate
            // Instead we'll use a reference to the borrow transaction ID
            
            // Ensure the PublicKey type for wallet
            const walletPublicKey = walletPubkey instanceof PublicKey ? walletPubkey : new PublicKey(walletPubkey);
            
            // Ensure the PublicKey type for sourceTokenAccount
            let sourceTokenPublicKey;
            if (typeof sourceTokenAccount === 'string') {
                sourceTokenPublicKey = new PublicKey(sourceTokenAccount);
            } else if (sourceTokenAccount instanceof PublicKey) {
                sourceTokenPublicKey = sourceTokenAccount;
            } else if (sourceTokenAccount && sourceTokenAccount.toBase58) {
                sourceTokenPublicKey = sourceTokenAccount;
            } else {
                console.error("Invalid sourceTokenAccount:", sourceTokenAccount);
                throw new Error("Invalid sourceTokenAccount type");
            }
            
            // Convert amount to BN if it's not already
            const amountBN = typeof amount === 'string' ? new BN(amount) : new BN(amount.toString());
            
            console.log(`Creating simple flash repay instruction for wallet: ${walletPublicKey.toBase58()}, source: ${sourceTokenPublicKey.toBase58()}, amount: ${amountBN.toString()}, borrowTx: ${borrowTransactionId || 'unknown'}`);
            
            // For simple repayment, we use index 0 since it's a separate transaction
            const repayData = Buffer.from(config.FLASH_REPAY_RESERVE_LIQUIDITY_DISCRIMINATOR);
            const amountBuffer = Buffer.alloc(8);
            amountBN.toBuffer('le', 8).copy(amountBuffer);
            const indexBuffer = Buffer.alloc(1);
            indexBuffer.writeUInt8(0); // Use 0 for separate transaction approach
            const data = Buffer.concat([repayData, amountBuffer, indexBuffer]);

            const keys = [
                { pubkey: walletPublicKey, isSigner: true, isWritable: true },
                { pubkey: config.KAMINO_LENDING_MARKET_AUTHORITY, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_LENDING_MARKET, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE, isSigner: false, isWritable: true },
                { pubkey: config.WSOL_MINT, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_SOL_RESERVE_LIQUIDITY, isSigner: false, isWritable: true },
                { pubkey: sourceTokenPublicKey, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_SOL_FEE_RECEIVER, isSigner: false, isWritable: true },
                { pubkey: config.KAMINO_REFERRER_TOKEN_STATE, isSigner: false, isWritable: false },
                { pubkey: config.KAMINO_REFERRER_ACCOUNT, isSigner: false, isWritable: false },
                { pubkey: config.SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
                { pubkey: config.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            ];

            return new TransactionInstruction({
                programId: config.KAMINO_LENDING_PROGRAM_ID,
                keys,
                data
            });
        } catch (error) {
            console.error("Error creating simple flash repay instruction:", error.message);
            throw error;
        }
    },
    
    getAssociatedTokenAddress: function(mint, owner) {
        try {
            if (!mint) {
                console.error("Missing mint in getAssociatedTokenAddress");
                throw new Error("Missing mint");
            }
            
            if (!owner) {
                console.error("Missing owner in getAssociatedTokenAddress");
                throw new Error("Missing owner");
            }
            
            // Ensure both are PublicKey instances
            const mintPubkey = mint instanceof PublicKey ? mint : new PublicKey(mint);
            const ownerPubkey = owner instanceof PublicKey ? owner : new PublicKey(owner);
            
            return PublicKey.findProgramAddressSync(
                [
                    ownerPubkey.toBuffer(),
                    config.TOKEN_PROGRAM_ID.toBuffer(),
                    mintPubkey.toBuffer()
                ],
                config.ASSOCIATED_TOKEN_PROGRAM_ID
            )[0];
        } catch (error) {
            console.error("Error in getAssociatedTokenAddress:", error.message);
            throw error;
        }
    },
    
    createAssociatedTokenAccountInstruction: function(owner, mint, payer) {
        try {
            if (!owner) {
                console.error("Missing owner in createAssociatedTokenAccountInstruction");
                throw new Error("Missing owner");
            }
            
            if (!mint) {
                console.error("Missing mint in createAssociatedTokenAccountInstruction");
                throw new Error("Missing mint");
            }
            
            if (!payer) {
                console.error("Missing payer in createAssociatedTokenAccountInstruction");
                throw new Error("Missing payer");
            }
            
            // Ensure all are PublicKey instances
            const ownerPubkey = owner instanceof PublicKey ? owner : new PublicKey(owner);
            const mintPubkey = mint instanceof PublicKey ? mint : new PublicKey(mint);
            const payerPubkey = payer.publicKey || (payer instanceof PublicKey ? payer : new PublicKey(payer));
            
            const associatedTokenAddress = utils.getAssociatedTokenAddress(mintPubkey, ownerPubkey);
            
            return {
                programId: config.ASSOCIATED_TOKEN_PROGRAM_ID,
                keys: [
                    { pubkey: payerPubkey, isSigner: true, isWritable: true },
                    { pubkey: associatedTokenAddress, isSigner: false, isWritable: true },
                    { pubkey: ownerPubkey, isSigner: false, isWritable: false },
                    { pubkey: mintPubkey, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: config.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                ],
                data: Buffer.from([])
            };
        } catch (error) {
            console.error("Error creating associated token account instruction:", error.message);
            throw error;
        }
    },
    
    // Enhanced createJitoTipTransaction function with better error handling
    createJitoTipTransaction: async function(tipAmount, payer, connection) {
        try {
            console.log(`Creating Jito tip transaction of ${tipAmount} lamports to ${config.JITO_TIP_ACCOUNT}`);
            
            // Validate inputs
            if (!tipAmount || tipAmount <= 0) {
                console.error("Invalid tip amount:", tipAmount);
                return null;
            }
            
            if (!payer || !payer.publicKey) {
                console.error("Invalid payer:", payer);
                return null;
            }
            
            if (!connection) {
                console.error("Invalid connection");
                return null;
            }
            
            // Ensure the tip account is a valid PublicKey
            let tipAccountPubkey;
            try {
                tipAccountPubkey = new PublicKey(config.JITO_TIP_ACCOUNT);
            } catch (error) {
                console.error(`Invalid Jito tip account address: ${config.JITO_TIP_ACCOUNT}`, error.message);
                return null;
            }
            
            // Get a recent blockhash with retry logic
            let blockhash;
            let retries = 3;
            while (retries > 0) {
                try {
                    const blockhashResponse = await connection.getLatestBlockhash('confirmed');
                    blockhash = blockhashResponse.blockhash;
                    if (blockhash) break;
                } catch (error) {
                    console.error(`Error getting blockhash (retries left: ${retries}):`, error.message);
                    retries--;
                    if (retries <= 0) {
                        console.error("Failed to get blockhash after all retries");
                        return null;
                    }
                    await utils.sleep(1000); // Wait before retrying
                }
            }
            
            if (!blockhash) {
                console.error("Failed to get a valid blockhash");
                return null;
            }
            
            // Create tip instruction
            const tipInstruction = SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: tipAccountPubkey,
                lamports: tipAmount
            });
            
            // Create and sign transaction
            const transaction = new Transaction();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = payer.publicKey;
            transaction.add(tipInstruction);
            
            // Sign transaction
            transaction.sign(payer);
            
            console.log(`Created tip transaction for ${tipAmount} lamports to ${tipAccountPubkey.toBase58()}`);
            return transaction;
        } catch (error) {
            console.error("Error creating tip transaction:", error.message);
            if (error.stack) {
                console.error("Error stack:", error.stack);
            }
            return null;
        }
    },
    
    waitForConfirmation: function(signature, connection, timeout = config.CONFIRMATION_TIMEOUT) {
        console.log(`Waiting for confirmation of ${signature}...`);
        let confirmed = false;
        let retries = timeout;
        
        return new Promise((resolve) => {
            function checkConfirmation() {
                if (confirmed || retries <= 0) {
                    if (!confirmed) {
                        console.log(`Transaction not confirmed after ${timeout} seconds. Check Solscan for status.`);
                    }
                    resolve(confirmed);
                    return;
                }
                
                connection.getSignatureStatus(signature)
                    .then(status => {
                        if (status && status.value) {
                            if (status.value.err) {
                                console.error(`Transaction FAILED with error:`, status.value.err);
                                confirmed = false;
                                resolve(false);
                                return;
                            } else if (status.value.confirmationStatus === 'confirmed' || 
                                      status.value.confirmationStatus === 'finalized') {
                                confirmed = true;
                                console.log(`Transaction confirmed with status: ${status.value.confirmationStatus}!`);
                                resolve(true);
                                return;
                            }
                        }
                        
                        retries--;
                        setTimeout(checkConfirmation, 1000);
                    })
                    .catch(error => {
                        console.log(`Error checking status (will retry): ${error.message}`);
                        retries--;
                        setTimeout(checkConfirmation, 1000);
                    });
            }
            
            checkConfirmation();
        });
    },
    
    // New functions for Address Lookup Tables
    
    /**
* Create and register a new address lookup table
     * @param {Connection} connection Solana connection
     * @param {Keypair} payer Transaction fee payer
     * @param {Array<PublicKey>} addresses Array of addresses to store in the table
     * @returns {Promise<{lookupTableAddress: PublicKey, slot: number}>} Lookup table address and slot
     */
    createAddressLookupTable: async function(connection, payer, addresses) {
        try {
            console.log(`Creating address lookup table with ${addresses.length} addresses...`);
            
            // Get recent slot for instruction
            const slot = await connection.getSlot('finalized');
            
            // Create instruction for lookup table creation
            const [lookupTableInst, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
                authority: payer.publicKey,
                payer: payer.publicKey,
                recentSlot: slot,
            });
            
            console.log(`Lookup table address: ${lookupTableAddress.toBase58()}`);
            
            // Build and send transaction to create table
            const { blockhash } = await connection.getLatestBlockhash();
            const messageV0 = new TransactionMessage({
                payerKey: payer.publicKey,
                recentBlockhash: blockhash,
                instructions: [lookupTableInst]
            }).compileToV0Message();
            
            const createTableTx = new VersionedTransaction(messageV0);
            
            // Sign and send the transaction
            createTableTx.sign([payer]);
            const createTableTxId = await connection.sendTransaction(createTableTx);
            
            // Wait for confirmation
            await utils.waitForConfirmation(createTableTxId, connection);
            console.log(`Created lookup table: ${lookupTableAddress.toBase58()}`);
            
            // Add addresses to the lookup table in batches (max 30 per tx)
            const BATCH_SIZE = 30;
            for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
                const batch = addresses.slice(i, i + BATCH_SIZE);
                console.log(`Adding batch ${Math.floor(i/BATCH_SIZE) + 1} (${batch.length} addresses) to lookup table...`);
                
                const extendInstruction = AddressLookupTableProgram.extendLookupTable({
                    payer: payer.publicKey,
                    authority: payer.publicKey,
                    lookupTable: lookupTableAddress,
                    addresses: batch
                });
                
                const { blockhash: newBlockhash } = await connection.getLatestBlockhash();
                const extendMessageV0 = new TransactionMessage({
                    payerKey: payer.publicKey,
                    recentBlockhash: newBlockhash,
                    instructions: [extendInstruction]
                }).compileToV0Message();
                
                const extendTx = new VersionedTransaction(extendMessageV0);
                
                // Sign and send the transaction
                extendTx.sign([payer]);
                const extendTxId = await connection.sendTransaction(extendTx);
                
                // Wait for confirmation
                await utils.waitForConfirmation(extendTxId, connection);
                console.log(`Added batch ${Math.floor(i/BATCH_SIZE) + 1} to lookup table`);
                
                // Wait a moment between batches to avoid rate limits
                await utils.sleep(1000);
            }
            
            // Return the lookup table address and slot
            return { lookupTableAddress, slot };
        } catch (error) {
            console.error("Error creating address lookup table:", error.message);
            throw error;
        }
    },

    /**
     * Get an existing address lookup table
     * @param {Connection} connection Solana connection
     * @param {PublicKey} lookupTableAddress Address of the lookup table
     * @returns {Promise<AddressLookupTableAccount>} The lookup table account
     */
    getAddressLookupTable: async function(connection, lookupTableAddress) {
        try {
            const lookupTableAccountInfo = await connection.getAddressLookupTable(lookupTableAddress);
            
            if (!lookupTableAccountInfo || !lookupTableAccountInfo.value) {
                throw new Error(`Lookup table not found: ${lookupTableAddress.toBase58()}`);
            }
            
            return lookupTableAccountInfo.value;
        } catch (error) {
            console.error("Error getting address lookup table:", error.message);
            throw error;
        }
    },

    /**
     * Check if all necessary addresses are in the lookup tables
     * @param {Array<AddressLookupTableAccount>} lookupTables Array of lookup tables
     * @param {Array<PublicKey>} requiredAddresses Array of addresses that need to be in the tables
     * @returns {boolean} True if all addresses are in the tables
     */
    checkAddressesInLookupTables: function(lookupTables, requiredAddresses) {
        if (!lookupTables || lookupTables.length === 0 || !requiredAddresses || requiredAddresses.length === 0) {
            return false;
        }
        
        // Combine all addresses from all lookup tables
        const tableAddresses = new Set();
        for (const table of lookupTables) {
            if (table && table.state && table.state.addresses) {
                for (const addr of table.state.addresses) {
                    tableAddresses.add(addr.toBase58());
                }
            }
        }
        
        // Check if all required addresses are in the combined set
        for (const addr of requiredAddresses) {
            const addrString = addr instanceof PublicKey ? addr.toBase58() : addr;
            if (!tableAddresses.has(addrString)) {
                console.log(`Address not found in lookup tables: ${addrString}`);
                return false;
            }
        }
        
        return true;
    },
    
    /**
     * Extract all unique accounts from instructions for lookup tables
     * @param {Array<TransactionInstruction>} instructions Array of instructions
     * @returns {Array<PublicKey>} Array of unique addresses
     */
    extractUniqueAccounts: function(instructions) {
        const uniqueAccounts = new Set();
        
        for (const instruction of instructions) {
            if (!instruction) continue;
            
            // Add program ID
            if (instruction.programId) {
                uniqueAccounts.add(instruction.programId.toBase58());
            }
            
            // Add all account keys
            if (instruction.keys) {
                for (const accountMeta of instruction.keys) {
                    if (accountMeta && accountMeta.pubkey) {
                        uniqueAccounts.add(accountMeta.pubkey.toBase58());
                    }
                }
            }
        }
        
        // Convert back to PublicKeys
        return Array.from(uniqueAccounts).map(addr => new PublicKey(addr));
    },
    
    /**
     * Create minimal instruction for smaller transaction size
     * @param {TransactionInstruction} instruction Original instruction
     * @returns {TransactionInstruction} Minimized instruction
     */
    minimizeInstruction: function(instruction) {
        if (!instruction) return null;
        
        // Already minimal if it's a TransactionInstruction instance
        if (instruction instanceof TransactionInstruction) {
            return instruction;
        }
        
        try {
            return new TransactionInstruction({
                programId: new PublicKey(instruction.programId),
                keys: instruction.accounts.map(account => ({
                    pubkey: new PublicKey(account.pubkey),
                    isSigner: !!account.isSigner,
                    isWritable: !!account.isWritable
                })),
                data: Buffer.from(instruction.data, 'base64')
            });
        } catch (error) {
            console.error("Error minimizing instruction:", error.message);
            return instruction; // Return original if minimization fails
        }
    }
};

module.exports = utils;
