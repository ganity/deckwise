# Extraction provenance and third-party notices

The converter and player source was extracted from TrainWise's MAIC/cloud-web
worktrees at the trees recorded by `provenance.json`. Existing copyright and
license notices are retained. MAIC's repository license is included under `vendor/origin/`; cloud-web declares
AGPL-3.0 in its package metadata but has no top-level license file. The
extraction does not replace upstream attribution.

The patched pptxtojson 2.1.0 distribution is vendored with its MIT license and
matching declarations. It is the exact distribution used by the verified D2f
converter, not a fresh unpatched registry install. The worker bundles it locally.
The local relationship-path fix resolves layout/master `.rels` beside the actual
part filename, including imported `dw-*` parts, rather than assuming Office's
conventional `slideLayout*`/`slideMaster*` names.

The authoring bundle uses MAIC's matching private PPTXGenJS 4.0.1 fork, not the
registry build. `vendor/pptxgenjs/` retains its built CommonJS distribution,
original package metadata and declarations. `authoring-provenance.json` records
the fork source tree and SHA-256 hashes. Its MIT license is retained there and
staged as `licenses/pptxgenjs/LICENSE`; the license was obtained from the upstream
v4.0.1 tag at https://raw.githubusercontent.com/gitbrent/PptxGenJS/v4.0.1/LICENSE.
The bundled distribution's additional copyright notices remain intact.

Native libraries and other npm dependencies retain their own package licenses;
standalone worker staging includes their package files. Local font directories
include the original OFL texts and font package licenses. These resources are
necessary to preserve the tested fallback metrics offline.
