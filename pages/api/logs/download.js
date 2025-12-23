/**
 * API endpoint to download logs
 * Collects logs from recent operations and returns as text file
 */
import { shopifyAdapter } from '../../../src/lib/adapters/shopify/index.js';
import { successAdapter } from '../../../src/lib/adapters/success/index.js';
import { mapShopifyOrderToBitrixDeal } from '../../../src/lib/bitrix/orderMapper.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    // Collect logs from various sources
    const logs = [];
    
    // Add timestamp
    logs.push('='.repeat(80));
    logs.push(`SHOPIFY-BITRIX INTEGRATION LOGS`);
    logs.push(`Generated: ${new Date().toISOString()}`);
    logs.push('='.repeat(80));
    logs.push('');

    // Environment information
    logs.push('='.repeat(80));
    logs.push('ENVIRONMENT INFORMATION');
    logs.push('='.repeat(80));
    logs.push('');
    logs.push(`Node.js Version: ${process.version}`);
    logs.push(`Platform: ${process.platform}`);
    logs.push(`Timestamp: ${new Date().toISOString()}`);
    logs.push('');

    // Get recent events
    logs.push('='.repeat(80));
    logs.push('RECENT WEBHOOK OPERATIONS');
    logs.push('='.repeat(80));
    logs.push('');

    try {
      const events = shopifyAdapter.getAllEvents();
      
      if (events && events.length > 0) {
        logs.push(`Total events: ${events.length}`);
        logs.push('');
        
        // Sort by received_at (most recent first)
        const sortedEvents = [...events].sort((a, b) => {
          const dateA = new Date(a.received_at || a.created_at || 0);
          const dateB = new Date(b.received_at || b.created_at || 0);
          return dateB - dateA;
        });

        sortedEvents.forEach((event, index) => {
          const eventId = event.id || event.eventId || `event-${index}`;
          const orderId = event.orderId || event.id || 'N/A';
          const receivedAt = event.received_at || event.created_at || 'N/A';
          const totalPrice = event.current_total_price || event.total_price || 'N/A';
          const currency = event.currency || 'EUR';
          const financialStatus = event.financial_status || 'N/A';
          const lineItemsCount = event.line_items ? event.line_items.length : 0;

          logs.push(`Event #${index + 1}: ${eventId}`);
          logs.push(`  Order ID: ${orderId}`);
          logs.push(`  Email: ${event.email || 'N/A'}`);
          logs.push(`  Received At: ${receivedAt}`);
          logs.push(`  Total Price: ${totalPrice} ${currency}`);
          logs.push(`  Financial Status: ${financialStatus}`);
          logs.push(`  Line Items: ${lineItemsCount}`);
          
          // Add line items details
          if (event.line_items && event.line_items.length > 0) {
            logs.push(`  Line Items Details:`);
            event.line_items.forEach((item, itemIndex) => {
              const currentQty = item.current_quantity ?? item.quantity ?? 0;
              logs.push(`    ${itemIndex + 1}. ${item.title || 'N/A'} (SKU: ${item.sku || 'N/A'})`);
              logs.push(`       Quantity: ${item.quantity || 0} → Current: ${currentQty}`);
              logs.push(`       Price: ${item.price || 'N/A'} ${currency}`);
            });
          }
          
          // ✅ Add Bitrix mapping details (product rows calculation)
          try {
            const { dealFields, productRows } = await mapShopifyOrderToBitrixDeal(event);
            logs.push(`  Bitrix Mapping Details:`);
            logs.push(`    Total Product Rows: ${productRows.length}`);
            logs.push(`    Deal OPPORTUNITY: ${dealFields.OPPORTUNITY || 'N/A'} ${dealFields.CURRENCY_ID || currency}`);
            
            // Count active line items
            const activeLineItems = event.line_items?.filter(item => {
              const currentQty = Number(item.current_quantity ?? item.quantity ?? 0);
              return currentQty > 0;
            }) || [];
            
            logs.push(`    Active Line Items: ${activeLineItems.length} (from ${event.line_items?.length || 0} total)`);
            
            // Show product rows breakdown
            if (productRows.length > 0) {
              logs.push(`    Product Rows Breakdown:`);
              const productRowsBySku = {};
              productRows.forEach(row => {
                const productName = row.PRODUCT_NAME || 'Unknown';
                const sku = productName.match(/SKU:\s*(\w+)/)?.[1] || 'N/A';
                if (!productRowsBySku[sku]) {
                  productRowsBySku[sku] = { count: 0, price: row.PRICE || 0, name: productName };
                }
                productRowsBySku[sku].count++;
              });
              
              Object.entries(productRowsBySku).forEach(([sku, data]) => {
                logs.push(`      - ${data.name}: ${data.count} row(s) × ${data.price} ${currency} = ${(data.count * data.price).toFixed(2)} ${currency}`);
              });
            }
          } catch (mappingError) {
            logs.push(`  Bitrix Mapping Error: ${mappingError.message}`);
          }
          
          logs.push('');
        });
      } else {
        logs.push('No events found.');
        logs.push('');
      }
    } catch (error) {
      logs.push(`Error collecting events: ${error.message}`);
      logs.push('');
    }

    // ✅ Add successful operations section
    logs.push('='.repeat(80));
    logs.push('SUCCESSFUL OPERATIONS');
    logs.push('='.repeat(80));
    logs.push('');

    try {
      const operations = successAdapter.getAllOperations();
      
      if (operations && operations.length > 0) {
        logs.push(`Total successful operations: ${operations.length}`);
        logs.push('');
        
        // Sort by timestamp (most recent first)
        const sortedOperations = [...operations].sort((a, b) => {
          const dateA = new Date(a.timestamp || a.stored_at || 0);
          const dateB = new Date(b.timestamp || b.stored_at || 0);
          return dateB - dateA;
        });

        sortedOperations.forEach((op, index) => {
          logs.push(`Operation #${index + 1}: ${op.id || op.operationId}`);
          logs.push(`  Type: ${op.operationType || 'N/A'}`);
          logs.push(`  Deal ID: ${op.dealId || 'N/A'}`);
          logs.push(`  Shopify Order ID: ${op.shopifyOrderId || 'N/A'}`);
          logs.push(`  Shopify Order Name: ${op.shopifyOrderName || 'N/A'}`);
          logs.push(`  Timestamp: ${op.timestamp || op.stored_at || 'N/A'}`);
          logs.push(`  Verified: ${op.verified ? 'Yes' : 'No'}`);
          if (op.attempt) {
            logs.push(`  Attempt: ${op.attempt}`);
          }
          if (op.wasDuplicate) {
            logs.push(`  Was Duplicate: Yes`);
          }
          if (op.productRowsCount !== undefined) {
            logs.push(`  Product Rows Count: ${op.productRowsCount}`);
          }
          if (op.updatedFields && Array.isArray(op.updatedFields)) {
            logs.push(`  Updated Fields: ${op.updatedFields.join(', ')}`);
          }
          
          // Add deal data summary
          if (op.dealData) {
            logs.push(`  Deal Data Summary:`);
            logs.push(`    TITLE: ${op.dealData.TITLE || 'N/A'}`);
            logs.push(`    OPPORTUNITY: ${op.dealData.OPPORTUNITY || 'N/A'} ${op.dealData.CURRENCY_ID || 'EUR'}`);
            logs.push(`    STAGE_ID: ${op.dealData.STAGE_ID || 'N/A'}`);
            logs.push(`    CATEGORY_ID: ${op.dealData.CATEGORY_ID || 'N/A'}`);
          }
          
          logs.push('');
        });
      } else {
        logs.push('No successful operations found.');
        logs.push('');
      }
    } catch (error) {
      logs.push(`Error collecting successful operations: ${error.message}`);
      logs.push('');
    }

    // ✅ Add RETRY ATTEMPTS section
    logs.push('='.repeat(80));
    logs.push('RETRY ATTEMPTS');
    logs.push('='.repeat(80));
    logs.push('');

    try {
      const operations = successAdapter.getAllOperations();
      
      if (operations && operations.length > 0) {
        const operationsWithRetries = operations.filter(op => op.attempt && op.attempt > 1);
        
        if (operationsWithRetries.length > 0) {
          logs.push(`Total operations with retries: ${operationsWithRetries.length}`);
          logs.push('');
          
          operationsWithRetries.forEach((op, index) => {
            logs.push(`Retry Operation #${index + 1}: ${op.id || op.operationId}`);
            logs.push(`  Type: ${op.operationType || 'N/A'}`);
            logs.push(`  Deal ID: ${op.dealId || 'N/A'}`);
            logs.push(`  Shopify Order ID: ${op.shopifyOrderId || 'N/A'}`);
            logs.push(`  Attempt: ${op.attempt || 'N/A'}`);
            logs.push(`  Was Duplicate: ${op.wasDuplicate ? 'Yes' : 'No'}`);
            logs.push(`  Timestamp: ${op.timestamp || op.stored_at || 'N/A'}`);
            logs.push('');
          });
        } else {
          logs.push('No operations required retries (all succeeded on first attempt).');
          logs.push('');
        }
      } else {
        logs.push('No operations found to analyze retries.');
        logs.push('');
      }
    } catch (error) {
      logs.push(`Error collecting retry information: ${error.message}`);
      logs.push('');
    }

    // ✅ Add VERIFICATION RESULTS section
    logs.push('='.repeat(80));
    logs.push('VERIFICATION RESULTS');
    logs.push('='.repeat(80));
    logs.push('');

    try {
      const operations = successAdapter.getAllOperations();
      
      if (operations && operations.length > 0) {
        const verifiedOperations = operations.filter(op => op.verified === true);
        const unverifiedOperations = operations.filter(op => op.verified === false);
        
        logs.push(`Total operations: ${operations.length}`);
        logs.push(`  Verified: ${verifiedOperations.length}`);
        logs.push(`  Unverified: ${unverifiedOperations.length}`);
        logs.push('');
        
        if (unverifiedOperations.length > 0) {
          logs.push(`Unverified Operations (${unverifiedOperations.length}):`);
          logs.push('');
          unverifiedOperations.forEach((op, index) => {
            logs.push(`  ${index + 1}. Operation: ${op.id || op.operationId}`);
            logs.push(`     Type: ${op.operationType || 'N/A'}`);
            logs.push(`     Deal ID: ${op.dealId || 'N/A'}`);
            logs.push(`     Shopify Order ID: ${op.shopifyOrderId || 'N/A'}`);
            logs.push(`     Timestamp: ${op.timestamp || op.stored_at || 'N/A'}`);
            logs.push(`     Note: Deal may have been deleted or verification failed`);
            logs.push('');
          });
        } else {
          logs.push('All operations were successfully verified.');
          logs.push('');
        }
      } else {
        logs.push('No operations found to analyze verification.');
        logs.push('');
      }
    } catch (error) {
      logs.push(`Error collecting verification information: ${error.message}`);
      logs.push('');
    }

    // ✅ Add ERRORS AND FAILURES section
    logs.push('='.repeat(80));
    logs.push('ERRORS AND FAILURES');
    logs.push('='.repeat(80));
    logs.push('');
    logs.push('Note: Detailed error logs are available in server-side console output.');
    logs.push('This section tracks operations that may indicate issues:');
    logs.push('');
    
    try {
      const operations = successAdapter.getAllOperations();
      
      if (operations && operations.length > 0) {
        // Check for operations with high retry counts (may indicate issues)
        const highRetryOperations = operations.filter(op => op.attempt && op.attempt >= 3);
        
        // Check for unverified operations (may indicate failures)
        const unverifiedOperations = operations.filter(op => op.verified === false);
        
        // Check for operations with zero product rows (may indicate data issues)
        const zeroProductRowsOperations = operations.filter(op => op.productRowsCount === 0 && op.operationType === 'CREATE');
        
        if (highRetryOperations.length > 0 || unverifiedOperations.length > 0 || zeroProductRowsOperations.length > 0) {
          if (highRetryOperations.length > 0) {
            logs.push(`Operations with high retry counts (${highRetryOperations.length}):`);
            highRetryOperations.forEach((op, index) => {
              logs.push(`  ${index + 1}. Operation: ${op.id || op.operationId}`);
              logs.push(`     Deal ID: ${op.dealId || 'N/A'}, Shopify Order: ${op.shopifyOrderId || 'N/A'}`);
              logs.push(`     Attempts: ${op.attempt || 'N/A'}`);
              logs.push(`     Note: High retry count may indicate Bitrix API issues or race conditions`);
              logs.push('');
            });
          }
          
          if (zeroProductRowsOperations.length > 0) {
            logs.push(`Operations with zero product rows (${zeroProductRowsOperations.length}):`);
            zeroProductRowsOperations.forEach((op, index) => {
              logs.push(`  ${index + 1}. Operation: ${op.id || op.operationId}`);
              logs.push(`     Deal ID: ${op.dealId || 'N/A'}, Shopify Order: ${op.shopifyOrderId || 'N/A'}`);
              logs.push(`     Note: Created deal with no product rows - may indicate all items were refunded/removed`);
              logs.push('');
            });
          }
        } else {
          logs.push('No obvious error indicators found in successful operations.');
          logs.push('All operations completed with reasonable retry counts and verification.');
          logs.push('');
        }
      } else {
        logs.push('No operations found to analyze for errors.');
        logs.push('');
      }
    } catch (error) {
      logs.push(`Error analyzing operations for failures: ${error.message}`);
      logs.push('');
    }

    logs.push('='.repeat(80));
    logs.push('NOTE');
    logs.push('='.repeat(80));
    logs.push('');
    logs.push('For detailed server-side logs (console.log output), check:');
    logs.push('  - Server console output (stdout/stderr)');
    logs.push('  - Application logs in production environment');
    logs.push('  - Deployment platform logs (Vercel, Render, etc.)');
    logs.push('');
    logs.push('This log file includes:');
    logs.push('  - Recent webhook events received from Shopify');
    logs.push('  - Event metadata (order ID, amounts, statuses)');
    logs.push('  - Line items information with current_quantity');
    logs.push('  - Bitrix mapping details (product rows, OPPORTUNITY calculation)');
    logs.push('  - Successful operations (created/updated deals with verification status)');
    logs.push('  - Retry attempts (operations that required multiple attempts)');
    logs.push('  - Verification results (deals verified after creation/update)');
    logs.push('  - Errors and failures (operations with high retry counts, unverified deals, etc.)');
    logs.push('');
    logs.push('Note: Detailed error logs (console.log output) are available in server-side logs.');
    logs.push('For production environments, check:');
    logs.push('  - Server console output (stdout/stderr)');
    logs.push('  - Application logs in deployment platform (Vercel, Render, etc.)');
    logs.push('');
    logs.push('='.repeat(80));
    logs.push(`End of log file - ${new Date().toISOString()}`);
    logs.push('='.repeat(80));

    // Convert to text
    const logText = logs.join('\n');

    // Set headers for file download
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shopify-bitrix-logs-${Date.now()}.txt"`);
    
    res.status(200).send(logText);
  } catch (error) {
    console.error('[LOGS DOWNLOAD] Error:', error);
    res.status(500).json({ error: 'Failed to generate logs', message: error.message });
  }
}

