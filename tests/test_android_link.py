"""The Play Store app is linked to the website by /.well-known/assetlinks.json. The owner fills the
package name and Google's certificate fingerprints in Settings → Website text; until then the
file is absent (404), which is what Android expects."""
import os as _os, pathlib as _pl
REPO = _os.environ.get("JT_REPO") or str(_pl.Path(__file__).resolve().parents[1])
SHOT = str(_pl.Path(__file__).resolve().parent / "_out"); _os.makedirs(SHOT, exist_ok=True)
CHROME = _os.environ.get("PW_CHROMIUM") or None
import os, json, time, tempfile, subprocess, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

PORT = 4619; BASE = f"http://127.0.0.1:{PORT}"; DATA = tempfile.mkdtemp(prefix="jt_android_")
FP1 = "fb:07:c4:18:61:89:6b:20:64:29:ad:bd:e0:77:ce:6a:a8:aa:a4:f6:36:3d:cc:46:66:b9:46:8d:3b:3e:dc:77"
FP2 = "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00"
os.environ["YOBAL_MAP_LOOKUP"] = "off"
subprocess.run(["pkill", "-9", "-f", "[n]ode server.js"], capture_output=True); time.sleep(1)
srv = subprocess.Popen(["node", "server.js"], cwd=REPO, env=dict(os.environ, DATA_DIR=DATA, PORT=str(PORT)),
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT); time.sleep(4)
def get(p):
    try: r = urllib.request.urlopen(BASE + p); return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, ""
def api(p, b=None, t=None):
    r = urllib.request.Request(BASE + p, data=json.dumps(b).encode() if b is not None else None,
        headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + t} if t else {})})
    return json.loads(urllib.request.urlopen(r).read())
fails = []
def chk(l, ok, x=""):
    print(("  PASS  " if ok else "  FAIL  ") + l + (("  -> " + str(x)) if x else ""))
    if not ok: fails.append(l)
try:
    tok = api("/api/admin/login", {"username": "owner", "password": "jeddah2026"})["token"]
    chk("no app linked yet: the file is absent", get("/.well-known/assetlinks.json")[0] == 404)
    with sync_playwright() as pw:
        br = pw.chromium.launch(**({'executable_path': CHROME} if CHROME else {}))
        pg = br.new_page(viewport={"width": 1280, "height": 900}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(BASE + "/admin", wait_until="networkidle"); pg.evaluate(f"sessionStorage.setItem('jt_token','{tok}')")
        pg.reload(wait_until="networkidle"); pg.wait_for_timeout(1200)
        pg.evaluate("document.querySelector('.navbtn[data-view=settings]').click()"); pg.wait_for_timeout(900)
        pg.click("[data-set-tab=website]"); pg.wait_for_timeout(300)
        chk("Settings → Website text has the Android app boxes", pg.is_visible("#s_android_package") and pg.is_visible("#s_android_cert_sha256"))
        pg.fill("#s_android_package", "com.shopjeddahtrading.app")
        pg.fill("#s_android_cert_sha256", FP1 + "\n" + FP2)
        pg.screenshot(path=SHOT + "/android_settings.png")
        with pg.expect_response(lambda r: "/api/admin/settings" in r.url and r.request.method != "GET") as resp:
            pg.evaluate("document.querySelector('#settingsForm').requestSubmit()")
        chk("saving works", resp.value.ok, resp.value.status)
        chk("no page errors", not errs, errs[:3])
        # The Play app never offers to install the app (it opens the shop with ?src=play)
        sp = br.new_page(viewport={"width": 390, "height": 860}, is_mobile=True)
        sp.goto(BASE + "/#help", wait_until="networkidle"); sp.wait_for_timeout(800)
        chk("in a browser, Help offers Install app", sp.is_visible("#helpInstall"))
        sp.goto(BASE + "/?src=play#help", wait_until="networkidle"); sp.wait_for_timeout(800)
        chk("in the Play app, Help has no Install app", not sp.is_visible("#helpInstall"))
        chk("…nor the menu", sp.evaluate("getComputedStyle(document.getElementById('menuInstall')).display") == "none")
        sp.goto(BASE + "/#help", wait_until="networkidle"); sp.wait_for_timeout(800)
        chk("…still hidden after moving around inside the app", not sp.is_visible("#helpInstall"))
        br.close()
    st, body = get("/.well-known/assetlinks.json")
    data = json.loads(body) if st == 200 else []
    t = data[0]["target"] if data else {}
    chk("the link file is served once filled in", st == 200)
    chk("…naming the app", t.get("package_name") == "com.shopjeddahtrading.app", t)
    chk("…with both fingerprints, in capitals", t.get("sha256_cert_fingerprints") == [FP1.upper(), FP2], t.get("sha256_cert_fingerprints"))
    chk("…for every link", data and data[0]["relation"] == ["delegate_permission/common.handle_all_urls"])
finally:
    srv.kill()
print("\nALL PASS" if not fails else f"\n{len(fails)} FAILED: {fails}")
raise SystemExit(1 if fails else 0)
