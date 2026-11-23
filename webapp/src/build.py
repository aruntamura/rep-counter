"""Inline dsp.js, sim.js and app.js into one page: docs/index.html (what GitHub Pages serves)."""
import pathlib
here = pathlib.Path(__file__).parent
src = (here / "index.src.html").read_text()
scripts = "".join(f"<script>\n{(here / f).read_text()}\n</script>\n" for f in ("dsp.js", "sim.js", "app.js"))
out = here.parent.parent / "docs" / "index.html"
out.write_text(src.replace("<!--SCRIPTS-->", scripts))
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
