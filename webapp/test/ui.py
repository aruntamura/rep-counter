import sys, json, pathlib
from playwright.sync_api import sync_playwright
url = (pathlib.Path(__file__).resolve().parents[2] / 'docs' / 'index.html').as_uri() + '?speed=10'
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ('light', 'dark'):
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, color_scheme=scheme, has_touch=True)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        pg.goto(url)
        pg.wait_for_timeout(300)
        pg.screenshot(path=f'/tmp/shot_setup_{scheme}.png', full_page=True)
        if scheme == 'light':
            pg.check('input[name=exercise][value=curl]')
        pg.click('#simBtn')
        pg.wait_for_timeout(2200)  # 1 s countdown in speed mode, then ~12 s of data
        pg.screenshot(path=f'/tmp/shot_live_{scheme}.png')
        pg.wait_for_selector('#results:not([hidden])', timeout=30000)
        pg.wait_for_timeout(400)
        s = pg.evaluate('''() => { const S = window.__repcounter.session; return { truth: S.sim.truth.length, live: S.engine.committed.length, exercise: S.exercise,
              disp: S.result.A.dips.length, angle: S.result.anglePeaks.length, freq: S.result.rr ? S.result.rr.fInterp * S.result.T : null, reps: S.result.A.reps.length }; }''')
        print(scheme, json.dumps(s))
        pg.screenshot(path=f'/tmp/shot_results_{scheme}.png', full_page=True)
        pg.click('text=How it counted')
        pg.wait_for_timeout(200)
        pg.screenshot(path=f'/tmp/shot_details_{scheme}.png', full_page=True)
        ctx.close()
    b.close()
print('errors:', errors)
