"""The Track your order page fits a phone: no sideways stretch, buttons wrap, nothing under the menu."""
import os as _os, pathlib as _pl
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None
import os, sys, json, time, tempfile, subprocess, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

PORT = 4592
BASE = f"http://127.0.0.1:{PORT}"
DATA = tempfile.mkdtemp(prefix="jt_trackm_")
subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)
srv = subprocess.Popen(["node", "server.js"], cwd=REPO,
        env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT)),
        stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
time.sleep(4)

fails = []
def chk(label, ok, extra=""):
    print(("  PASS  " if ok else "  FAIL  ") + label + (("  → " + str(extra)) if extra else ""))
    if not ok: fails.append(label)

def api(path, body=None, token=None):
    r = urllib.request.Request(BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})},
        method="POST" if body is not None else "GET")
    try: return json.loads(urllib.request.urlopen(r).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())

try:
    tok = api("/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    zone = api("/api/admin/zones", {"name": "Serrekunda", "fee": 150}, tok)
    zid = zone.get("id") or (zone.get("zone") or {}).get("id")
    p = api("/api/admin/products", {"name_en": "Premium Ajwa Dates from Madinah 1kg box", "name_ar": "تمر عجوة",
        "cat": "herbs", "price": 1250, "stock": 50, "is_active": 1}, tok)["id"]
    o = api("/api/orders", {"customer_name": "Awa Njie", "customer_phone": "2207001122",
        "delivery_method": "home", "delivery_zone_id": zid, "delivery_address": "Latrikunda",
        "items": [{"id": p, "qty": 2}]})
    ref = o["order_number"]

    with sync_playwright() as pw:
        b = pw.chromium.launch(**({"executable_path": CHROME} if CHROME else {}))
        for lang in ("en", "ar"):
            for w in (320, 360, 414):
                pg = b.new_page(viewport={"width": w, "height": 800}, is_mobile=True, has_touch=True)
                pg.goto(BASE + "/#track=" + ref); pg.wait_for_timeout(1200)
                if lang == "ar":
                    pg.evaluate("()=>{LANG='ar';applyLang();handleRoute();}"); pg.wait_for_timeout(600)
                pg.fill("#tkPhone", "2207001122"); pg.click("#tkGo"); pg.wait_for_timeout(1500)
                m = pg.evaluate("""()=>({W:innerWidth, sw:document.documentElement.scrollWidth,
                    dir:document.documentElement.dir,
                    btns:[...document.querySelectorAll('.track-actions .btn')].map(b=>{const r=b.getBoundingClientRect();return [r.left,r.right]}),
                    inFont:parseFloat(getComputedStyle(document.querySelector('#tkPhone')).fontSize)})""")
                tag = f"{lang} {w}px"
                chk(f"{tag}: the page is as wide as the phone, not wider", m["W"] == w and m["sw"] <= w, (m["W"], m["sw"]))
                chk(f"{tag}: all four buttons are on screen",
                    len(m["btns"]) == 4 and all(l >= -1 and r <= w + 1 for l, r in m["btns"]), m["btns"])
                chk(f"{tag}: phone box is 16px so iPhones don't zoom in on tap", m["inFont"] >= 16, m["inFont"])
                if lang == "ar": chk(f"{tag}: page reads right to left", m["dir"] == "rtl")
                pg.evaluate("()=>scrollTo(0,document.body.scrollHeight)"); pg.wait_for_timeout(500)
                g = pg.evaluate("""()=>{const a=document.querySelector('.track-actions [data-chat-order]').getBoundingClientRect().bottom;
                    const navs=[...document.querySelectorAll('body *')].filter(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();
                      return s.position==='fixed'&&s.display!=='none'&&r.height>30&&r.width>200&&r.bottom>=innerHeight-2&&r.top>innerHeight/2});
                    return {a, top:navs.length?Math.min(...navs.map(e=>e.getBoundingClientRect().top)):innerHeight}}""")
                chk(f"{tag}: last button is above the bottom menu", g["a"] <= g["top"], g)
                pg.screenshot(path=f"{SHOT}/track_{lang}_{w}.png", full_page=True); pg.close()
        b.close()
finally:
    srv.kill()

print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED")
sys.exit(1 if fails else 0)
