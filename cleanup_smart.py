import requests
import json
import time

WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

PROD_IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330
]

def delete_related_documents(product_id):
    """Find and delete related docs for a product."""
    try:
        url = f"{WEBHOOK}catalog.document.element.list"
        params = {"filter[elementId]": product_id}
        resp = requests.get(url, params=params).json()

        raw_result = resp.get("result")
        elements = []

        if isinstance(raw_result, list):
            elements = raw_result
        elif isinstance(raw_result, dict):
            if 'documentElements' in raw_result:
                elements = raw_result['documentElements']
            elif 'item' in raw_result:
                elements = raw_result['item']
            else:
                elements = list(raw_result.values())

        if not elements:
            return True

        doc_ids = set()
        for el in elements:
            if isinstance(el, dict):
                d_id = el.get('DOC_ID') or el.get('docId') or el.get('doc_id')
                if d_id:
                    doc_ids.add(d_id)

        doc_ids = list(doc_ids)
        if not doc_ids:
            return True

        print(f"      Docs found: {len(doc_ids)} ({doc_ids})")

        all_deleted = True
        for doc_id in doc_ids:
            # Cancel
            requests.post(f"{WEBHOOK}catalog.document.cancel", json={"id": doc_id})
            time.sleep(0.1)
            # Delete
            del_resp = requests.post(f"{WEBHOOK}catalog.document.delete", json={"id": doc_id}).json()
            if not del_resp.get("result"):
                print(f"      Failed to delete doc {doc_id}")
                all_deleted = False
            else:
                print(f"      Deleted doc {doc_id}")
            time.sleep(0.1)

        return all_deleted

    except Exception as e:
        print(f"      Error checking docs: {e}")
        return False

def delete_product_full(product_id):
    if not delete_related_documents(product_id):
        print(f"   Docs not cleared completely.")

    try:
        # Check active status first
        requests.post(f"{WEBHOOK}crm.product.update", json={"id": product_id, "fields": {"ACTIVE": "N"}})
        
        resp = requests.post(f"{WEBHOOK}crm.product.delete", json={"id": product_id}).json()
        if resp.get("result"):
            print(f"   Success: {product_id} deleted")
            return True
        else:
            err = resp.get('error_description', 'Error')
            print(f"   Fail: {product_id} - {err}")
            return False
    except Exception as e:
        print(f"   Api error: {e}")
        return False

def main():
    print(f"Smart cleaning {len(PROD_IDS)} products...")
    
    for pid in PROD_IDS:
        print(f"\nProcessing {pid}...")
        delete_product_full(pid)
        time.sleep(0.2)

if __name__ == "__main__":
    main()
