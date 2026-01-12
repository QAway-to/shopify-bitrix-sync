import requests

BITRIX_WEBHOOK = "https://bfcshoes.bitrix24.eu/rest/52/zrbhiktlam8mz1yr/"

SECTIONS = {
    36: "A-F",
    38: "G-M", 
    40: "N-S",
    42: "T-Z"
}

def count_section(section_id):
    resp = requests.post(f"{BITRIX_WEBHOOK}crm.product.list", json={
        "select": ["ID"],
        "filter": {"SECTION_ID": section_id},
        "start": 0
    }).json()
    
    total = resp.get("total", 0)
    return total

print("=== SECTION PRODUCT COUNT ===\n")

results = []
for sid, name in SECTIONS.items():
    count = count_section(sid)
    results.append((sid, name, count))
    print(f"Section {sid} ({name}): {count} products")

results.sort(key=lambda x: x[2])
print(f"\nSmallest: {results[0][1]} (ID {results[0][0]}) - {results[0][2]} products")
print(f"Largest:  {results[-1][1]} (ID {results[-1][0]}) - {results[-1][2]} products")
