import requests
import time

BITRIX = 'https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/'
# Collect IDs manually or via search
IDS = [
    10292, 10294, 10296, 10298, 10300, 10302, 10304, 10306, 10308, 10310,
    10312, 10314, 10316, 10318, 10320, 10322, 10324, 10326, 10328, 10330
]

print(f"Deleting {len(IDS)} items...")

for pid in IDS:
    try:
        r = requests.post(BITRIX + 'crm.product.delete', json={'id': pid})
        res = r.json()
        if res.get("result") == True:
            print(f"Deleted {pid}: OK")
        else:
            print(f"Deleted {pid}: FAIL - {res}")
        time.sleep(0.5) # Prevent rate limit
    except Exception as e:
        print(f"Error {pid}: {e}")
