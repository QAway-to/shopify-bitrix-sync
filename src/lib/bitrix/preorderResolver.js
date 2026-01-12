/**
 * Pre-order Product Resolver
 * Handles "Title | Size" format from Bitrix deals and auto-resolves to Shopify variant
 */

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

/**
 * Check if product name matches "Title | Size" pattern
 * @param {string} productName - Product name from Bitrix
 * @returns {Object|null} - { title, size } or null if no match
 */
export function parsePreorderInput(productName) {
    if (!productName || typeof productName !== 'string') return null;

    const trimmed = productName.trim();

    // Pattern: "Product Title | Size"
    // Size can be: 31, 32, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46
    // or S, M, L, XL, XXL, etc.
    const match = trimmed.match(/^(.+)\s*\|\s*(\d{2,3}|[SMLX]{1,3}L?)$/i);

    if (match) {
        return {
            title: match[1].trim(),
            size: match[2].trim()
        };
    }

    return null;
}

/**
 * Search Shopify for product by title
 * @param {string} title - Product title to search
 * @returns {Object|null} - Product object or null
 */
async function searchShopifyProduct(title) {
    try {
        // URL encode the title for search
        const encodedTitle = encodeURIComponent(title);
        const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?title=${encodedTitle}&limit=5`;

        const response = await fetch(url, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
        });

        if (!response.ok) {
            console.error(`[PREORDER RESOLVER] Shopify search failed: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const products = data.products || [];

        if (products.length === 0) {
            console.warn(`[PREORDER RESOLVER] No products found for title: "${title}"`);
            return null;
        }

        // Find exact match first
        const exactMatch = products.find(p => p.title.toLowerCase() === title.toLowerCase());
        if (exactMatch) {
            console.log(`[PREORDER RESOLVER] Exact match found: ${exactMatch.title} (ID: ${exactMatch.id})`);
            return exactMatch;
        }

        // Fallback to first result
        console.log(`[PREORDER RESOLVER] Using first match: ${products[0].title} (ID: ${products[0].id})`);
        return products[0];

    } catch (error) {
        console.error(`[PREORDER RESOLVER] Search error:`, error.message);
        return null;
    }
}

/**
 * Find variant by size in product
 * @param {Object} product - Shopify product object
 * @param {string} size - Size value (e.g., "31", "M")
 * @returns {Object|null} - Variant object or null
 */
function findVariantBySize(product, size) {
    if (!product?.variants) return null;

    const sizeLower = size.toLowerCase();

    // Check each variant's options
    for (const variant of product.variants) {
        // Check option1, option2, option3
        const options = [variant.option1, variant.option2, variant.option3].filter(Boolean);

        for (const opt of options) {
            if (opt.toLowerCase() === sizeLower) {
                console.log(`[PREORDER RESOLVER] Found variant for size ${size}: variant_id=${variant.id}, sku=${variant.sku}`);
                return variant;
            }
        }

        // Also check variant title
        if (variant.title.toLowerCase() === sizeLower) {
            console.log(`[PREORDER RESOLVER] Found variant by title for size ${size}: variant_id=${variant.id}`);
            return variant;
        }
    }

    console.warn(`[PREORDER RESOLVER] No variant found for size ${size} in product ${product.id}`);
    return null;
}

/**
 * Get product metadata (color, etc.) from Shopify product
 * @param {Object} product - Shopify product object
 * @param {Object} variant - Shopify variant object
 * @returns {Object} - Metadata { vendor, product_type, color, size }
 */
function extractProductMetadata(product, variant) {
    let colorIndex = -1;
    let sizeIndex = -1;

    // Find color and size option indices
    for (let i = 0; i < (product.options || []).length; i++) {
        const name = (product.options[i].name || '').toLowerCase();
        if (name.includes('color') || name.includes('colour') || name.includes('цвет')) {
            colorIndex = i;
        } else if (name.includes('size') || name.includes('размер')) {
            sizeIndex = i;
        }
    }

    return {
        vendor: product.vendor || '',
        product_type: product.product_type || '',
        color: colorIndex >= 0 ? variant[`option${colorIndex + 1}`] : '',
        size: sizeIndex >= 0 ? variant[`option${sizeIndex + 1}`] : variant.option1 || '',
        description: product.body_html || ''
    };
}

/**
 * Main function: Resolve pre-order product from "Title | Size" format
 * @param {string} productName - Product name in "Title | Size" format
 * @returns {Object|null} - { variant, product, metadata } or null
 */
export async function resolvePreorderProduct(productName) {
    console.log(`[PREORDER RESOLVER] Starting resolution for: "${productName}"`);

    // Step 1: Parse input
    const parsed = parsePreorderInput(productName);
    if (!parsed) {
        console.log(`[PREORDER RESOLVER] Input does not match "Title | Size" pattern`);
        return null;
    }

    console.log(`[PREORDER RESOLVER] Parsed: title="${parsed.title}", size="${parsed.size}"`);

    // Step 2: Search Shopify for product
    const product = await searchShopifyProduct(parsed.title);
    if (!product) {
        console.error(`[PREORDER RESOLVER] Product not found in Shopify: "${parsed.title}"`);
        return null;
    }

    // Step 3: Find variant by size
    const variant = findVariantBySize(product, parsed.size);
    if (!variant) {
        console.error(`[PREORDER RESOLVER] Variant not found for size ${parsed.size} in product ${product.id}`);
        return null;
    }

    // Step 4: Extract metadata
    const metadata = extractProductMetadata(product, variant);

    console.log(`[PREORDER RESOLVER] ✅ Resolved: variant_id=${variant.id}, sku=${variant.sku}, color=${metadata.color}`);

    return {
        variant,
        product,
        metadata,
        parsed
    };
}

export default {
    parsePreorderInput,
    resolvePreorderProduct
};
