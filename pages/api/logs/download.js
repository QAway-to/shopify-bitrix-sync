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
          const currency = event.currency || 'EUR';
          const financialStatus = event.financial_status || 'N/A';
          const lineItemsCount = event.line_items ? event.line_items.length : 0;

          logs.push(`Event #${index + 1}: ${eventId}`);
          logs.push(`  Order ID: ${orderId}`);
          logs.push(`  Email: ${event.email || 'N/A'}`);
          logs.push(`  Received At: ${receivedAt}`);
          logs.push(`  Financial Status: ${financialStatus}`);
          logs.push(`  Line Items: ${lineItemsCount}`);
          
          // ✅ Show price breakdown for clarity
          logs.push(`  Price Information:`);
          logs.push(`    - Original Total (total_price): ${event.total_price || 'N/A'} ${currency}`);
          logs.push(`    - Paid Amount (current_total_price): ${event.current_total_price || 'N/A'} ${currency}`);
          
          // Calculate active items total (same logic as orderMapper and UI)
          let activeItemsTotal = 0;
          if (event.line_items && Array.isArray(event.line_items)) {
            for (const item of event.line_items) {
              const currentQuantity = Number(item.current_quantity ?? item.quantity ?? 0);
              if (currentQuantity > 0) {
                const itemPrice = Number(item.price || 0);
                const itemTotal = itemPrice * currentQuantity;
                const itemDiscount = Number(
                  item.discount_allocations?.[0]?.amount ||
                  item.discount_allocations?.[0]?.amount_set?.shop_money?.amount ||
                  item.total_discount ||
                  0
                );
                activeItemsTotal += itemTotal - itemDiscount;
              }
            }
            const shippingPrice = Number(
              event.current_total_shipping_price_set?.shop_money?.amount ||
              event.total_shipping_price_set?.shop_money?.amount ||
              event.shipping_price ||
              event.shipping_lines?.[0]?.price ||
              0
            );
            activeItemsTotal += shippingPrice;
          }
          logs.push(`    - Active Items Total (used in Bitrix OPPORTUNITY): ${activeItemsTotal > 0 ? activeItemsTotal.toFixed(2) : 'N/A'} ${currency}`);
          
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
            const { dealFields, productRows } = mapShopifyOrderToBitrixDeal(event);
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
                // Try to extract SKU from product name or use index
                const skuMatch = productName.match(/SKU:\s*(\w+)/i);
                const sku = skuMatch ? skuMatch[1] : productName.substring(0, 20); // Use first 20 chars if no SKU
                if (!productRowsBySku[sku]) {
                  productRowsBySku[sku] = { count: 0, price: row.PRICE || 0, name: productName };
                }
                productRowsBySku[sku].count++;
              });
              
              Object.entries(productRowsBySku).forEach(([sku, data]) => {
                logs.push(`      - ${data.name}: ${data.count} row(s) × ${data.price} ${currency} = ${(data.count * data.price).toFixed(2)} ${currency}`);
              });
            }
            
            // ✅ Add stage and payment status mapping info
            if (dealFields.STAGE_ID) {
              logs.push(`    Stage ID (STAGE_ID): ${dealFields.STAGE_ID}`);
            }
            if (dealFields.UF_CRM_1739183959976) {
              const paymentStatusMap = {
                '56': 'Paid',
                '58': 'Unpaid',
                '60': '10% prepayment'
              };
              const paymentStatusText = paymentStatusMap[dealFields.UF_CRM_1739183959976] || dealFields.UF_CRM_1739183959976;
              logs.push(`    Payment Status (UF_CRM_1739183959976): ${dealFields.UF_CRM_1739183959976} (${paymentStatusText})`);
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
    logs.push('  - Event metadata (order ID, email, financial status)');
    logs.push('  - Price breakdown (original total, paid amount, active items total)');
    logs.push('  - Line items information with quantity and current_quantity');
    logs.push('  - Bitrix mapping details:');
    logs.push('    * Product rows (calculated from active line_items)');
    logs.push('    * OPPORTUNITY (sum of active items + shipping)');
    logs.push('    * Stage ID (based on financial status)');
    logs.push('    * Payment status (Paid/Unpaid/10% prepayment)');
    logs.push('  - Successful operations (created/updated deals with verification status)');
    logs.push('');
    logs.push('Note: Error tracking is currently logged to console only.');
    logs.push('Future versions will include error storage and retrieval in logs.');
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

