"""
Inventory Sync Script - BATCH Version (50x Faster)
- Uses Bitrix 'batch' method to send 50 commands per request
- Aggregates stock updates into fewer documents
- Includes PROPERTY mapping (Size, Brand, Category, Color)
- Dynamic Option Mapping (Size/Color from Shopify Options)
"""

import requests
import json
import time
import sys
import codecs
from typing import Dict, List, Optional, Tuple

# Note: Removed codecs.getwriter hack - it causes stdout to hang in some terminal environments

# ============ CREDENTIALS ============
SHOPIFY_STORE = "83bfa8-c4.myshopify.com"
SHOPIFY_TOKEN = "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"
BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

# ============ SECTION MAPPING ============
SECTION_MAP = {
    'category-a-f': 36,
    'category-g-m': 38,
    'category-n-s': 40,
    'category-t-z': 42,
}

# ============ PROPERTY MAPPING ============
PROPERTIES = {
    "SIZE": 98,
    "BRAND": 102,
    "CATEGORY": 104,
    "COLOR": 106
}

# ============ SIZE ENUM MAPPING (Bitrix property98 values) ============
SIZE_ENUM_MAP = {
    "20": 154, "21": 156, "22": 158, "23": 160, "24": 162,
    "25": 164, "26": 166, "27": 168, "28": 170, "29": 172,
    "30": 174, "31": 176, "32": 178, "33": 320, "34": 322,
    "35": 324, "36": 326, "37": 328, "38": 330, "39": 332,
    "40": 334, "41": 336, "42": 338, "43": 340, "44": 342,
    "45": 344, "46": 346, "47": 348, "48": 350, "49": 352,
    "50": 354, "51": 356, "52": 358, "53": 360, "54": 362
}

def get_size_enum_id(size_text: str) -> Optional[int]:
    """Convert size text (e.g. '40') to Bitrix enum ID (e.g. 334)"""
    if not size_text:
        return None
    # Clean the size text
    size_clean = size_text.strip()
    return SIZE_ENUM_MAP.get(size_clean)

def get_category_by_sku(sku: str) -> str:
    """Get category name based on SKU first letter"""
    if not sku: return 'category-g-m'
    first_char = sku[0].lower()
    if 'a' <= first_char <= 'f': return 'category-a-f'
    elif 'g' <= first_char <= 'm': return 'category-g-m'
    elif 'n' <= first_char <= 's': return 'category-n-s'
    elif 't' <= first_char <= 'z': return 'category-t-z'
    return 'category-g-m'

def get_section_id_by_sku(sku: str) -> int:
    return SECTION_MAP.get(get_category_by_sku(sku), 38)

# ============ SHOPIFY API ============
# ============ SHOPIFY API ============
def fetch_shopify_products(filter_qty_gt_zero: bool = True, target_variant_id: str = None) -> List[Dict]:
    """Fetch products from Shopify API (Optimized + Option Parsing)"""
    all_variants = []
    
    # === OPTIMIZATION: Single Variant Fetch ===
    if target_variant_id:
        print(f"\n[SHOPIFY] FAST Fast-fetching single variant: {target_variant_id}")
        try:
            # 1. Fetch Variant
            v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{target_variant_id}.json"
            v_resp = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json"})
            
            if v_resp.status_code != 200:
                print(f"[SHOPIFY] ERR Variant not found: {v_resp.text}")
                return []
                
            variant_data = v_resp.json().get("variant")
            product_id = variant_data.get("product_id")
            
            # 2. Fetch Parent Product (for Options, Brand, Type)
            p_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products/{product_id}.json"
            p_resp = requests.get(p_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json"})
            
            if p_resp.status_code != 200:
                print(f"[SHOPIFY] ERR Parent product not found: {p_resp.text}")
                return []
                
            product_data = p_resp.json().get("product")
            
            # Treat as list of 1 product containing 1 variant (for consistent processing logic below)
            # We construct the structure expected by the parsing logic or just parse it here directly.
            # Let's reuse the parsing logic by putting it in a list.
            
            # But wait, product_data['variants'] has ALL variants. We only want the target one.
            # Let's filter later or just build the object here.
            # Reusing the loop logic is safer to ensure identical parsing.
            products_to_process = [product_data] 
            
        except Exception as e:
            print(f"[SHOPIFY] ERR Error fetching single item: {e}")
            return []
    else:
        # Full Fetch Mode
        print("\n[SHOPIFY] Fetching all products...")
        products_to_process = []
        page_info = None
        has_next = True
        
        start_time = time.time()
        last_log = start_time
        
        while has_next:
            url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=250"
            if page_info:
                url += f"&page_info={page_info}"
            
            response = requests.get(url, headers={
                "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json"
            })
            
            if response.status_code != 200:
                print(f"[SHOPIFY] Error: {response.text}")
                break
            
            data = response.json()
            products_to_process.extend(data.get("products", []))
            
            link_header = response.headers.get("Link", "")
            has_next = False
            page_info = None
            
            # Robust Parsing for rel="next"
            if "rel=\"next\"" in link_header:
                links = link_header.split(',')
                for link in links:
                    if 'rel="next"' in link and 'page_info=' in link:
                        try:
                            # format: <url?page_info=...>; rel="next"
                            # extract between page_info= and >
                            page_info = link.split('page_info=')[1].split('>')[0]
                            has_next = True
                            break
                        except: pass
            
            # Time-based log (Every 60s)
            if time.time() - last_log > 60:
                elapsed = int(time.time() - start_time)
                print(f"  [SHOPIFY] Working... {elapsed}s elapsed. Fetched {len(products_to_process)} items so far.")
                last_log = time.time()

    # === PROCESS PRODUCTS ===
    print(f"[SHOPIFY] Processing {len(products_to_process)} products...")
    
    # DEBUG: Check first product description
    if products_to_process:
        print(f"[DEBUG SHOPIFY] First Body HTML (Len): {len(products_to_process[0].get('body_html', '') or '')}")
    
    for product in products_to_process:
        product_vendor = product.get("vendor", "")
        product_type = product.get("product_type", "")
        
        # --- Dynamic Option Mapping ---
        size_index = -1
        color_index = -1
        
        for i, opt in enumerate(product.get("options", [])):
            name = opt.get("name", "").lower()
            if "size" in name or "размер" in name or "eu size" in name:
                size_index = i
            elif "color" in name or "colour" in name or "цвет" in name:
                color_index = i
        
        for variant in product.get("variants", []):
            vid = str(variant["id"])
            
            # Filter if target specified
            if target_variant_id and vid != target_variant_id:
                continue
            
            qty = variant.get("inventory_quantity", 0)
            if filter_qty_gt_zero and qty <= 0 and not target_variant_id: 
                continue
            
            size_val = variant.get(f"option{size_index+1}") if size_index >= 0 else ""
            color_val = variant.get(f"option{color_index+1}") if color_index >= 0 else ""
            
            # Fallback title parsing
            if not size_val and " - " in variant.get("title", ""):
                parts = variant["title"].split(" - ")
                if len(parts) > 1:
                    # heuristic
                    pass
            
            if not size_val and variant.get("title") != "Default Title":
                size_val = variant.get("title")

            all_variants.append({
                "product_id": product["id"],
                "product_title": product["title"],
                "variant_id": vid,
                "variant_title": variant.get("title", ""),
                "sku": variant.get("sku", ""),
                "price": float(variant.get("price", 0)),
                "qty": qty,
                "brand": product_vendor,
                "category": product_type,
                "color": color_val,
                "size": size_val,
                "description": product.get("body_html", "") or ""
            })
            
    print(f"[SHOPIFY] Fetched {len(all_variants)} variants to sync")
    return all_variants

# ============ BITRIX BATCH API ============
def call_batch(commands: Dict[str, str], halt_on_error: bool = False) -> Dict:
    """Execute a batch of commands"""
    if not commands: return {}
    
    url = f"{BITRIX_WEBHOOK}batch"
    response = requests.post(url, json={
        "halt": 1 if halt_on_error else 0,
        "cmd": commands
    })
    return response.json()

def execute_batches(commands: List[Tuple[str, str]], batch_size: int = 50):
    """Execute list of commands in chunks of 50"""
    total = len(commands)
    print(f"[BATCH] Executing {total} commands...")
    
    for i in range(0, total, batch_size):
        chunk = commands[i:i+batch_size]
        batch_cmd = {f"cmd_{j}": cmd for j, (key, cmd) in enumerate(chunk)}
        
        try:
            result = call_batch(batch_cmd)
            # Check for errors in batch result
            if result.get("result_error"):
                print(f"  WARN️ Batch Error: {result['result_error']}")
        except Exception as e:
            print(f"  ERR Network Error: {e}")
            
        print(f"  Processed {min(i+batch_size, total)}/{total}")
        time.sleep(0.5) # Slight delay to be safe

# ============ BITRIX API (READ) ============
def fetch_all_bitrix_products_fast() -> Dict[str, Dict]:
    """Fetch all products from Bitrix (ID, XML_ID only needed for existence check)"""
    all_products = {}
    
    # Use standard list method 
    start = 0
    start_time = time.time()
    last_log = start_time
    
    while True:
        url = f"{BITRIX_WEBHOOK}crm.product.list"
        resp = requests.post(url, json={
            "select": ["ID", "PRICE", "XML_ID", "NAME", "PROPERTY_98", "PROPERTY_102", "DETAIL_TEXT", "SECTION_ID"], # Fetch properties + Description
            "start": start
        }).json()
        
        items = resp.get("result", [])
        if not items: break
        
        for item in items:
            if item.get("XML_ID"):
                all_products[item["XML_ID"]] = item
        
        if len(items) < 50: break
        start = resp.get("next")
        if not start: break
        
        # Time-based log (Every 60s)
        if time.time() - last_log > 60:
             elapsed = int(time.time() - start_time)
             print(f"  [BITRIX] Indexing... {elapsed}s elapsed. Loaded {len(all_products)} products.")
             last_log = time.time()
            
    print(f"[BITRIX] Indexed {len(all_products)} products")
    return all_products

def get_current_stocks_batch(product_ids: List[int], store_id: int = 2) -> Dict[int, int]:
    """
    Get stocks for multiple products using batch.
    NOTE: We remove filter[STORE_ID] and filter manually relative to store_id=2 
    to avoid potential API filter issues (case sensitivity etc).
    """
    stocks = {}
    commands = []
    
    # Prepare commands - FETCH ALL STOCKS for product (safer)
    # Removing select[] to ensure we get everything, including storeId in whatever case
    # FIX: Use 'productId' (camelCase) as 'PRODUCT_ID' seems to be ignored or act weirdly in some batch contexts?
    # Actually, looking at user's script, they use "productId".
    for pid in product_ids:
        cmd = f"catalog.storeproduct.list?filter[productId]={pid}"
        commands.append((str(pid), cmd))
    
    # Execute
    print(f"[STOCK] Fetching stocks for {len(commands)} products from Store {store_id}...")
    
    for i in range(0, len(commands), 50):
        chunk = commands[i:i+50]
        batch_cmd = {key: cmd for key, cmd in chunk}
        
        resp = call_batch(batch_cmd)
        results = resp.get("result", {}).get("result", {})
        
        for key, data in results.items():
            pid = int(key)
            amount = 0
            found_store = False
            
            # DEBUG: Print raw response for problematic product
            if pid == 9864: # Target test ID from logs
                print(f"\n[DEBUG RAW] PID {pid} Response: {json.dumps(data, indent=2)}")
            
            if data and "storeProducts" in data:
                 for store_prod in data["storeProducts"]:
                     # Check if this is our target store (handle both cases)
                     sid = int(store_prod.get("storeId") or store_prod.get("STORE_ID") or 0)
                     if sid == store_id:
                         # Double check it is the right product (since filter failed before)
                         p_check = int(store_prod.get("productId") or store_prod.get("PRODUCT_ID") or 0)
                         if p_check != pid:
                             # This should not happen if filter works, but let's be safe
                             continue
                             
                         raw_amount = store_prod.get("amount")
                         if raw_amount is None: raw_amount = store_prod.get("AMOUNT")
                         amount = int(float(raw_amount)) if raw_amount is not None else 0
                         found_store = True
                         break
            
            stocks[pid] = amount
            
            # Debug log for significant amounts or if missing
            if not found_store:
                print(f"  [WARN] PID {pid}: Store {store_id} NOT FOUND in response (Assumed 0). Response keys: {[s.get('storeId') for s in data.get('storeProducts', [])]}")
            elif amount > 0:
                print(f"  [STOCK FOUND] PID {pid}: Store {store_id} -> {amount}")
            
        print(f"[STOCK] Loaded {min(i+50, len(commands))}/{len(commands)} stocks")
        
    return stocks

# ============ SYNC LOGIC ============
def run_batch_sync(target_variant_ids: List[str] = None, target_section_ids: List[int] = None):
    """
    Run batch sync.
    
    Args:
        target_variant_ids: List of variant IDs to sync (for testing specific products)
        target_section_ids: List of section IDs to sync (e.g. [36] for A-F only, or [36,38,40,42] for all)
                           If None, syncs ALL sections.
    """
    print("="*60)
    print("BATCH INVENTORY SYNC (With Properties + Title)")
    if target_variant_ids:
        print(f"TARGET VARIANTS: {target_variant_ids}")
    if target_section_ids:
        section_names = {36: 'A-F', 38: 'G-M', 40: 'N-S', 42: 'T-Z'}
        names = [section_names.get(sid, str(sid)) for sid in target_section_ids]
        print(f"TARGET SECTIONS: {', '.join(names)} (IDs: {target_section_ids})")
    if not target_variant_ids and not target_section_ids:
        print("MODE: FULL SYNC (all sections)")
    print("="*60)
    
    # 1. Fetch Data
    # If specific variants requested, fetch them one by one
    if target_variant_ids:
        shopify_variants = []
        for vid in target_variant_ids:
            result = fetch_shopify_products(filter_qty_gt_zero=False, target_variant_id=vid)
            shopify_variants.extend(result)
        print(f"[SHOPIFY] Fetched {len(shopify_variants)} target variants")
    else:
        # We fetch ALL, including 0 qty, so we can update existing items. 
        # But we will prevent CREATING new 0-qty items below.
        shopify_variants = fetch_shopify_products(filter_qty_gt_zero=False, target_variant_id=None)
    
    if not shopify_variants:
        print("No variants found in Shopify for sync.")
        return
    
    # 1.1 Filter by Section (if specified)
    bitrix_products = fetch_all_bitrix_products_fast()
    
    # 1.1 Filter by Section (if specified)
    if target_section_ids and not target_variant_ids:
        original_count = len(shopify_variants)
        
        # Build set of XML_IDs currently in the target Bitrix sections
        bx_ids_in_section = set()
        for vid, b_prod in bitrix_products.items():
            b_sec = int(b_prod.get("SECTION_ID", 0) or 0)
            if b_sec in target_section_ids:
                bx_ids_in_section.add(vid)
        
        filtered_variants = []
        for v in shopify_variants:
            vid = str(v["variant_id"])
            sku = v.get("sku", "") or ""
            
            # Condition 1: SKU matches section
            matches_sku = get_section_id_by_sku(sku) in target_section_ids
            
            # Condition 2: Already in Bitrix Section (Fallback for items without SKU)
            matches_bitrix = vid in bx_ids_in_section
            
            if matches_sku or matches_bitrix:
                filtered_variants.append(v)
                
        shopify_variants = filtered_variants
        print(f"[FILTER] Filtered to {len(shopify_variants)}/{original_count} variants for target sections (SKU match or Bitrix fallback)")
    
    # 2. Plan Changes
    create_payloads = []
    update_payloads = []
    description_updates = [] # New list for description specific updates
    ensure_stock_ids = []
    
    print("\n[PLANNING] Calculating differences...")
    
    variant_map = {v["variant_id"]: v for v in shopify_variants}
    
    # Identify Create vs Update
    for vid, variant in variant_map.items():
        s_price = variant["price"]
        
        # Determine Properties
        props = {}
        if variant.get("size"):
            enum_id = get_size_enum_id(variant["size"])
            if enum_id:
                props[f"PROPERTY_{PROPERTIES['SIZE']}"] = enum_id

        if variant.get("brand"): props[f"PROPERTY_{PROPERTIES['BRAND']}"] = variant["brand"]
        if variant.get("category"): props[f"PROPERTY_{PROPERTIES['CATEGORY']}"] = variant["category"]
        if variant.get("color"): props[f"PROPERTY_{PROPERTIES['COLOR']}"] = variant["color"]
        
        if vid in bitrix_products:
            # --- UPDATE ---
            b_prod = bitrix_products[vid]
            pid = b_prod["ID"]
            
            updates = []
            
            # 0. NAME Check (Title sync)
            shopify_name = f"{variant['product_title']} - {variant['variant_title']}"
            # Clean up "Default Title" variant names
            if variant['variant_title'] == 'Default Title' or not variant['variant_title']:
                shopify_name = variant['product_title']
            
            b_name = b_prod.get("NAME", "")
            
            # Debug: Always print NAME comparison for target variants
            if target_variant_ids:
                print(f"  [DEBUG NAME] Bitrix: '{b_name}'")
                print(f"  [DEBUG NAME] Shopify: '{shopify_name}'")
                print(f"  [DEBUG NAME] Match: {b_name == shopify_name}")
            
            if b_name != shopify_name:
                # URL encode the name for batch command
                encoded_name = shopify_name.replace(" ", "%20").replace("&", "%26")
                updates.append(f"fields[NAME]={encoded_name}")
                print(f"  [NAME] {pid}: '{b_name}' -> '{shopify_name}'")
            
            # 0.1 DESCRIPTION Check - MOVED TO SEPARATE PASS (below)
            # We skip adding it to 'updates' here to avoid mixing crm.product.update with catalog fields complexity.
            # Instead we track needed updates.
            s_desc = variant.get("description", "").strip()
            b_desc = b_prod.get("DETAIL_TEXT", "").strip()
            
            if s_desc != b_desc:
                # Add to a separate list for processing
                description_updates.append({
                    "id": pid,
                    "desc": s_desc
                })
                # print(f"  [DESC] {pid}: Queued description update")

            # 1. Price Check
            b_price = float(b_prod.get("PRICE", 0) or 0)
            if abs(b_price - s_price) > 0.01:
                updates.append(f"fields[PRICE]={s_price}")
            
            # 2. Property Check (Always update properties for Target items, or if missing)
            # For target variants OR target sections, FORCE update all properties
            if target_variant_ids or target_section_ids:
                 for p_id, p_val in props.items():
                     encoded_val = str(p_val).replace(" ", "%20").replace("&", "%26")
                     updates.append(f"fields[{p_id}]={encoded_val}")
            
            if updates:
                # Join with &
                # Be careful with URL encoding for values with spaces
                # Quick fix for spaces:
                updates_str = "&".join([u.replace(" ", "%20") for u in updates])
                cmd = f"crm.product.update?id={pid}&{updates_str}"
                update_payloads.append((f"update_{pid}", cmd))
                
                print(f"  QUEUE Queued Update for ID {pid}: {updates}")
            
            ensure_stock_ids.append(pid)
        else:
            # --- CREATE ---
            # ONLY create if qty > 0. Do not create new products with 0 stock.
            if variant['qty'] <= 0:
                continue

            sku = variant["sku"]
            section_id = get_section_id_by_sku(sku)
            name = f"{variant['product_title']} - {variant['variant_title']}"
            
            fields = {
                "NAME": name,
                "PRICE": variant["price"],
                "CURRENCY_ID": "EUR",
                "CATALOG_ID": 14,
                "SECTION_ID": section_id,
                "CODE": sku,
                "XML_ID": vid,
                "ACTIVE": "Y",
                "DETAIL_TEXT": variant.get("description", ""),
                "DETAIL_TEXT_TYPE": "html",
                "PREVIEW_TEXT": variant.get("description", ""),
                "PREVIEW_TEXT_TYPE": "html"
            }
            # Merge props
            fields.update(props)
            
            create_payloads.append(fields)
            
    # 3. Execute Product Updates (Batch)
    if update_payloads:
        execute_batches(update_payloads)
    
    # 3.1 Execute Description Updates (Separate Batch)
    if description_updates:
        print(f"\n[DESC] Processing {len(description_updates)} description updates...")
        import urllib.parse
        
        desc_cmds = []
        for item in description_updates:
            # Use catalog.product.update with camelCase fields as per user example
            # fields[detailText]=...&fields[detailTextType]=html
            encoded_desc = urllib.parse.quote(item['desc'])
            # Note: catalog.product.update requires 'id' in fields? No, usually ID is separate param or key.
            # In batch: ?id=...&fields[...]
            cmd = f"catalog.product.update?id={item['id']}&fields[detailText]={encoded_desc}&fields[detailTextType]=html&fields[previewText]={encoded_desc}&fields[previewTextType]=html"
            desc_cmds.append((f"desc_{item['id']}", cmd))
            print(f"  [DESC] {item['id']}: Updating description (Length: {len(item['desc'])})")
            
        execute_batches(desc_cmds)

    # 4. Execute Creates (1-by-1)
    created_map = {} 
    print(f"\n[CREATE] Creating {len(create_payloads)} new products...")
    
    for fields in create_payloads:
        res = requests.post(f"{BITRIX_WEBHOOK}crm.product.add", json={"fields": fields}).json()
        new_id = res.get("result")
        if new_id:
            created_map[fields["XML_ID"]] = new_id
            ensure_stock_ids.append(new_id)
            print(f"  OK Created ID {new_id}: {fields['NAME']}")
        else:
            print(f"  ERR Failed to create {fields['NAME']}: {res}")
            
    # 5. Check and Sync Stocks
    if ensure_stock_ids:
        print(f"\n[STOCK] Checking levels for {len(ensure_stock_ids)} products...")
        current_stocks = get_current_stocks_batch(ensure_stock_ids)
        
        # Pid mapping
        pid_to_variant = {}
        for vid, b_prod in bitrix_products.items():
            pid_to_variant[int(b_prod["ID"])] = variant_map.get(vid)
        for vid, new_pid in created_map.items():
            pid_to_variant[new_id] = variant_map.get(vid)
            
        arrival_items = []
        deduct_items = []
        
        for pid, current_qty in current_stocks.items():
            variant = pid_to_variant.get(pid)
            if not variant: continue
            
            target_qty = variant["qty"]
            diff = target_qty - current_qty
            
            if diff > 0:
                arrival_items.append({"id": pid, "amount": diff})
            elif diff < 0:
                deduct_items.append({"id": pid, "amount": abs(diff)})
                
        # 6. Apply Stock Docs
        def apply_stock_changes(items, doc_type):
            if not items: return
            
            chunk_size = 100
            for i in range(0, len(items), chunk_size):
                chunk = items[i:i+chunk_size]
                
                title = f"Batch Sync {doc_type} {i}-{i+len(chunk)}"
                res = requests.post(f"{BITRIX_WEBHOOK}catalog.document.add", json={
                    "fields": {
                        "docType": doc_type,
                        "title": title,
                        "responsibleId": 52,
                        "currency": "EUR"
                    }
                }).json()
                
                doc_id = res.get("result", {}).get("document", {}).get("id")
                if not doc_id: 
                    print("ERR Failed to create stock doc")
                    continue
                
                
                element_cmds = []
                for item in chunk:
                    # Detect store logic based on doc type
                    # S (Arrival/Adj) -> storeTo=2
                    # D (Deduct) -> storeFrom=2, storeTo=""
                    store_field = f"fields[storeTo]=2"
                    if doc_type == "D":
                        store_field = f"fields[storeFrom]=2"
                    
                    cmd = f"catalog.document.element.add?fields[docId]={doc_id}&fields[elementId]={item['id']}&fields[amount]={item['amount']}&fields[purchasingPrice]=0&{store_field}"
                    element_cmds.append((f"add_{item['id']}", cmd))
                
                execute_batches(element_cmds)
                requests.post(f"{BITRIX_WEBHOOK}catalog.document.conduct", json={"id": doc_id})
                print(f"  OK Conducted document {doc_id} ({len(chunk)} items) [Type: {doc_type}]")

        if arrival_items:
            print(f"\n[STOCK] Processing {len(arrival_items)} arrivals...")
            apply_stock_changes(arrival_items, "S")  # Use 'S' (Stock Adjustment) instead of 'A' (Receipt stays in Draft)
            
        if deduct_items:
            print(f"\n[STOCK] Processing {len(deduct_items)} deducts...")
            apply_stock_changes(deduct_items, "D")  # Use 'D' (Deduct)
    else:
        print("[STOCK] No products to sync stock for.")

    # ============ STEP 7: Zero-Stock Sync for Existing Bitrix Products ============
    # For products that exist in Bitrix (have XML_ID) but Shopify qty = 0:
    # Create write-off document to sync stock down to 0
    if not target_variant_ids:  # Only run in full sync mode
        print("\n[ZERO-STOCK] Checking existing Bitrix products for Shopify qty=0...")
        
        # Get all Bitrix product XML_IDs (variant IDs)
        existing_xml_ids = set(bitrix_products.keys())
        print(f"[ZERO-STOCK] Found {len(existing_xml_ids)} products in Bitrix with XML_ID")
        
        # Fetch current Shopify inventory for these variants
        # We need to check if their Shopify qty is 0
        zero_stock_items = []
        
        for xml_id, bx_prod in bitrix_products.items():
            # Skip if this variant was already processed in main sync (qty > 0)
            if xml_id in variant_map:
                continue
            
            # SKIP CHECK for short IDs (legacy Bitrix IDs 2900, 3000 etc are not Shopify IDs)
            if len(str(xml_id)) < 10:
                continue

            # SKIP CHECK if product belongs to a different section (when filtering by section)
            if target_section_ids:
                b_section = int(bx_prod.get("SECTION_ID", 0) or 0)
                if b_section not in target_section_ids:
                    # distinct helpful log only for debug
                    # print(f"  [ZERO-STOCK] Skipping ID {xml_id} (Section {b_section} not in target)")
                    continue

            # Check Shopify inventory for this variant
            try:
                v_url = f"https://{SHOPIFY_STORE}/admin/api/2024-01/variants/{xml_id}.json"
                v_resp = requests.get(v_url, headers={"X-Shopify-Access-Token": SHOPIFY_TOKEN})
                
                if v_resp.status_code == 200:
                    variant_data = v_resp.json().get("variant", {})
                    shopify_qty = variant_data.get("inventory_quantity", 0)
                    
                    if shopify_qty <= 0:
                        # This variant has 0 stock in Shopify, check Bitrix
                        pid = int(bx_prod["ID"])
                        zero_stock_items.append(pid)
                elif v_resp.status_code == 404:
                    # Variant doesn't exist in Shopify anymore
                    print(f"  [ZERO-STOCK] Variant {xml_id} not found in Shopify (deleted?)")
                    pid = int(bx_prod["ID"])
                    zero_stock_items.append(pid)
            except Exception as e:
                print(f"  [ZERO-STOCK] Error checking {xml_id}: {e}")
        
        if zero_stock_items:
            print(f"[ZERO-STOCK] Found {len(zero_stock_items)} products to check for stock reduction")
            
            # Get current Bitrix stock levels
            current_stocks = get_current_stocks_batch(zero_stock_items)
            
            # Filter to only those with Bitrix stock > 0
            deduct_to_zero = []
            for pid, bx_qty in current_stocks.items():
                if bx_qty > 0:
                    deduct_to_zero.append({"id": pid, "amount": bx_qty})
                    print(f"  [ZERO-STOCK] Product {pid}: Bitrix={bx_qty}, Shopify=0 → Will deduct {bx_qty}")
            
            if deduct_to_zero:
                print(f"\n[ZERO-STOCK] Processing {len(deduct_to_zero)} write-offs...")
                apply_stock_changes(deduct_to_zero, "D")  # Use 'D' (Deduct)
            else:
                print("[ZERO-STOCK] No products need stock reduction")
        else:
            print("[ZERO-STOCK] No products with Shopify qty=0 found")

    print(f"\nOK Sync Complete!")

if __name__ == "__main__":
    # ============ CONFIGURATION ============
    
    # Option 1: Full Sync (all sections)
    # run_batch_sync()
    
    # Option 2: Sync specific sections
    # Section IDs: 36=A-F, 38=G-M, 40=N-S, 42=T-Z
    run_batch_sync(target_section_ids=[42])  # Only T-Z
    # run_batch_sync(target_section_ids=[36, 38])  # A-F and G-M
    # run_batch_sync(target_section_ids=[36, 38, 40, 42])  # All sections
    
    # Option 3: Test specific variants (by Shopify variant_id)
    # Find variant IDs in Shopify Admin -> Products -> Variant -> URL contains variant_id
    # run_batch_sync(target_variant_ids=["50420394000648"])  # Single variant test
    # run_batch_sync(target_variant_ids=["50244958454024"])  # Multiple variants

