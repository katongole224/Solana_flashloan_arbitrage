/**
 * This script creates and sets up Address Lookup Tables for arbitrage operations
 * Run this script before starting your arbitrage bot to ensure tables are ready
 */
const { 
    Connection, 
    Keypair, 
    PublicKey, 
    AddressLookupTableProgram,
    VersionedTransaction,
    TransactionMessage 
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const utils = require('./utils');

// Location to store lookup table information
const LOOKUP_TABLES_FILE = path.join(__dirname, 'lookup_tables.json');

/**
 * Define common accounts that will likely be used in arbitrage transactions
 */
function getCommonArbitrageAccounts() {
    const accounts = [
        // System program and token programs
        "11111111111111111111111111111111", // System Program
        config.TOKEN_PROGRAM_ID.toBase58(), // Token Program
        config.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), // Associated Token Program
        config.SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), // Sysvar Instructions
        
        // Kamino lending addresses for flash loans
        config.KAMINO_LENDING_PROGRAM_ID.toBase58(),
        config.KAMINO_LENDING_MARKET.toBase58(),
        config.KAMINO_LENDING_MARKET_AUTHORITY.toBase58(),
        config.KAMINO_SOL_RESERVE.toBase58(),
        config.KAMINO_SOL_RESERVE_LIQUIDITY.toBase58(),
        config.KAMINO_SOL_FEE_RECEIVER.toBase58(),
        config.KAMINO_REFERRER_TOKEN_STATE.toBase58(),
        config.KAMINO_REFERRER_ACCOUNT.toBase58(),
        
        // Token mints
        config.WSOL_MINT.toBase58(),
        config.USDC_MINT.toBase58(),
        config.USDT_MINT.toBase58(),
        config.BONK_MINT.toBase58(),
        
        // Jupiter swap program
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5dELihNr6",
    ];
    
    // Add commonly used DEX program IDs
    const dexPrograms = [
        "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", // Serum v3
        "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", // OpenBook
        "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CMMM
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium
        "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpools
        "EoTcMgcDRTJVZDMZWBoU6rhYHZfkNTVEAfz3uUJRcYGj", // Meteora
    ];
    
    return [...accounts, ...dexPrograms];
}

/**
 * Create and set up Address Lookup Tables
 */
async function setupLookupTables() {
    try {
        console.log("=== SETTING UP ADDRESS LOOKUP TABLES FOR ARBITRAGE ===");
        
        // Initialize wallet and connection
        const privateKeyBytes = utils.base58Decode(config.PRIVATE_KEY);
        const payer = Keypair.fromSecretKey(privateKeyBytes);
        console.log(`Using wallet: ${payer.publicKey.toBase58()}`);
        
        const connection = new Connection(config.RPC_ENDPOINT, 'confirmed');
        
        // Check wallet balance
        const balance = await connection.getBalance(payer.publicKey);
        console.log(`Wallet balance: ${balance / 1000000000} SOL`);
        
        if (balance < 10000000) {
            console.error("Insufficient balance for lookup table creation. Need at least 0.01 SOL.");
            return false;
        }
        
        // Load existing lookup tables if available
        let existingTables = [];
        try {
            if (fs.existsSync(LOOKUP_TABLES_FILE)) {
                const tableData = JSON.parse(fs.readFileSync(LOOKUP_TABLES_FILE, 'utf8'));
                existingTables = tableData.tables || [];
                console.log(`Loaded ${existingTables.length} existing lookup tables from file`);
            }
        } catch (err) {
            console.log("No existing lookup tables found or error loading them:", err.message);
            existingTables = [];
        }
        
        // Verify existing tables are valid
        const verifiedTables = [];
        for (const table of existingTables) {
            try {
                console.log(`Verifying lookup table: ${table.address}`);
                const lookupTableAccount = await connection.getAddressLookupTable(new PublicKey(table.address));
                
                if (lookupTableAccount && lookupTableAccount.value) {
                    const addressCount = lookupTableAccount.value.state.addresses.length;
                    console.log(`Verified lookup table ${table.address} with ${addressCount} addresses`);
                    
                    verifiedTables.push({
                        address: table.address,
                        slot: table.slot,
                        addresses: lookupTableAccount.value.state.addresses.map(addr => addr.toBase58())
                    });
                } else {
                    console.log(`Lookup table ${table.address} not found or invalid`);
                }
            } catch (err) {
                console.log(`Error verifying lookup table ${table.address}:`, err.message);
            }
        }
        
        // Get common accounts for arbitrage
        const commonAccounts = getCommonArbitrageAccounts();
        console.log(`Identified ${commonAccounts.length} common accounts for arbitrage operations`);
        
        // Add the wallet address
        commonAccounts.push(payer.publicKey.toBase58());
        
        // Check if we need to create new lookup tables
        // Combine all addresses from verified tables
        const existingAddresses = new Set();
        for (const table of verifiedTables) {
            for (const addr of table.addresses) {
                existingAddresses.add(addr);
            }
        }
        
        // Find missing addresses
        const missingAddresses = commonAccounts.filter(addr => !existingAddresses.has(addr));
        
        if (missingAddresses.length > 0) {
            console.log(`Found ${missingAddresses.length} addresses that need to be added to lookup tables`);
            
            // Each lookup table can hold up to 256 addresses
            const MAX_ADDRESSES_PER_TABLE = 256;
            
            // Check if we need a new table or can extend existing ones
            if (verifiedTables.length === 0) {
                console.log("No existing tables. Creating a new lookup table...");
                
                const { lookupTableAddress, slot } = await createLookupTable(
                    connection,
                    payer,
                    missingAddresses.map(addr => new PublicKey(addr))
                );
                
                console.log(`Created new lookup table: ${lookupTableAddress.toBase58()} at slot ${slot}`);
                
                // Add to our verified tables
                verifiedTables.push({
                    address: lookupTableAddress.toBase58(),
                    slot,
                    addresses: missingAddresses
                });
            } else {
                // Check if we can add to an existing table
                const lastTable = verifiedTables[verifiedTables.length - 1];
                
                if (lastTable.addresses.length + missingAddresses.length <= MAX_ADDRESSES_PER_TABLE) {
                    // We can extend the existing table
                    console.log(`Extending existing lookup table ${lastTable.address} with ${missingAddresses.length} addresses`);
                    
                    await extendLookupTable(
                        connection,
                        payer,
                        new PublicKey(lastTable.address),
                        missingAddresses.map(addr => new PublicKey(addr))
                    );
                    
                    // Update our record
                    lastTable.addresses = [...lastTable.addresses, ...missingAddresses];
                    console.log(`Extended lookup table ${lastTable.address}, now has ${lastTable.addresses.length} addresses`);
                } else {
                    // We need to create a new table
                    console.log("Creating new lookup table for additional addresses...");
                    
                    const { lookupTableAddress, slot } = await createLookupTable(
                        connection,
                        payer,
                        missingAddresses.map(addr => new PublicKey(addr))
                    );
                    
                    console.log(`Created new lookup table: ${lookupTableAddress.toBase58()} at slot ${slot}`);
                    
                    // Add to our verified tables
                    verifiedTables.push({
                        address: lookupTableAddress.toBase58(),
                        slot,
                        addresses: missingAddresses
                    });
                }
            }
        } else {
            console.log("All required accounts are already in lookup tables. No changes needed.");
        }
        
        // Save updated lookup tables to file
        const tableData = {
            updated: new Date().toISOString(),
            tables: verifiedTables
        };
        
        fs.writeFileSync(LOOKUP_TABLES_FILE, JSON.stringify(tableData, null, 2));
        console.log(`Saved ${verifiedTables.length} lookup tables to ${LOOKUP_TABLES_FILE}`);
        
        // Print summary
        console.log("\n=== LOOKUP TABLE SETUP COMPLETE ===");
        console.log(`Total lookup tables: ${verifiedTables.length}`);
        
        for (let i = 0; i < verifiedTables.length; i++) {
            const table = verifiedTables[i];
            console.log(`Table ${i+1}: ${table.address} (${table.addresses.length} addresses)`);
        }
        
        console.log("\nYou can now use these lookup tables for arbitrage operations.");
        return true;
    } catch (error) {
        console.error("Error setting up lookup tables:", error.message);
        return false;
    }
}

/**
 * Create a new lookup table
 */
async function createLookupTable(connection, payer, addresses) {
    console.log(`Creating new lookup table with ${addresses.length} addresses...`);
    
    // Get recent slot for instruction
    const slot = await connection.getSlot('finalized');
    
    // Create instruction for lookup table creation
    const [createInstruction, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot,
    });
    
    // Build and send transaction to create table
    const { blockhash } = await connection.getLatestBlockhash();
    
    const messageV0 = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [createInstruction]
    }).compileToV0Message();
    
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([payer]);
    
    const signature = await connection.sendTransaction(transaction);
    console.log(`Creation transaction sent: ${signature}`);
    
    // Wait for confirmation
    await waitForConfirmation(connection, signature);
    console.log(`Lookup table created at ${lookupTableAddress.toBase58()}`);
    
    // Add addresses in batches
    if (addresses.length > 0) {
        await extendLookupTable(connection, payer, lookupTableAddress, addresses);
    }
    
    return { lookupTableAddress, slot };
}

/**
 * Extend an existing lookup table with new addresses
 */
async function extendLookupTable(connection, payer, lookupTableAddress, addresses) {
    if (!addresses || addresses.length === 0) {
        console.log("No addresses to add to lookup table");
        return;
    }
    
    // Add addresses in batches of 30 to avoid transaction size limits
    const BATCH_SIZE = 30;
    const totalBatches = Math.ceil(addresses.length / BATCH_SIZE);
    
    console.log(`Adding ${addresses.length} addresses to lookup table in ${totalBatches} batches...`);
    
    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
        const batchAddresses = addresses.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
        
        console.log(`Adding batch ${batchNumber}/${totalBatches} (${batchAddresses.length} addresses)...`);
        
        const extendInstruction = AddressLookupTableProgram.extendLookupTable({
            payer: payer.publicKey,
            authority: payer.publicKey,
            lookupTable: lookupTableAddress,
            addresses: batchAddresses
        });
        
        const { blockhash } = await connection.getLatestBlockhash();
        
        const messageV0 = new TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: [extendInstruction]
        }).compileToV0Message();
        
        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([payer]);
        
        const signature = await connection.sendTransaction(transaction);
        console.log(`Batch ${batchNumber} transaction sent: ${signature}`);
        
        // Wait for confirmation
        await waitForConfirmation(connection, signature);
        console.log(`Batch ${batchNumber} confirmed`);
        
        // Wait a bit between batches to avoid rate limits
        if (i + BATCH_SIZE < addresses.length) {
            console.log("Waiting 1 second before next batch...");
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    console.log(`Successfully added all addresses to lookup table ${lookupTableAddress.toBase58()}`);
}

/**
 * Wait for transaction confirmation
 */
async function waitForConfirmation(connection, signature, timeout = 60) {
    console.log(`Waiting for confirmation of transaction ${signature}...`);
    
    const start = Date.now();
    
    // Check status in a loop
    while (Date.now() - start < timeout * 1000) {
        try {
            const { value } = await connection.getSignatureStatus(signature);
            
            if (value) {
                if (value.err) {
                    throw new Error(`Transaction failed with error: ${JSON.stringify(value.err)}`);
                }
                
                if (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized') {
                    console.log(`Transaction confirmed with status: ${value.confirmationStatus}`);
                    return true;
                }
            }
            
            // Wait a second before checking again
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            console.error(`Error checking transaction status: ${error.message}`);
            // Continue checking despite error
        }
    }
    
    throw new Error(`Transaction confirmation timed out after ${timeout} seconds`);
}

// Execute the setup
setupLookupTables()
    .then(success => {
        if (success) {
            console.log("Lookup table setup completed successfully!");
        } else {
            console.error("Lookup table setup failed.");
            process.exit(1);
        }
    })
    .catch(error => {
        console.error("Error in lookup table setup:", error.message);
        process.exit(1);
    });