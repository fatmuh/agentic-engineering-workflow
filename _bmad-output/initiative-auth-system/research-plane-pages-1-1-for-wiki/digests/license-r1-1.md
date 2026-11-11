# Digest — license & portability (round 1)
Agent: general-purpose, 7 tool calls, 2026-11-04. Sources: raw.githubusercontent.com (preview) + api.github.com + registry.npmjs.org.

## Claims
- One license doc: LICENSE.txt at repo root = GNU AGPL v3.0. GitHub API license.spdx_id AGPL-3.0. [high, license]
- No other LICENSE/NOTICE/COPYING in tree; apps/api/plane/license + web license components are source code (license-registration Django app / pricing modal), not license grants. No ee/ dir. [high, license]
- Pages UI apps/web/**/components/pages/** and packages/editor all under the single AGPL-3.0 grant. [high, packaging]
- packages/editor/package.json: @plane/editor v1.5.0, private true, license AGPL-3.0. [high, license+packaging]
- No Plane package on npm: @plane/editor, @plane/rich-text-editor, @plane/document-editor, @plane/lite-editor, @plane/block-editor, @plane/ui, @plane/shared all Not Found. [high, packaging]
- README: "This project is licensed under the [GNU Affero General Public License v3.0]". [high, license]
- Upstream engine is MIT: @tiptap/core on npm = MIT, latest 3.32.2; editor also deps yjs etc. [high, packaging]
- Default branch = preview (not master); LICENSE.txt is the file name (LICENSE w/o ext 404s). [high, packaging]

## License findings
AGPL v3.0, Section 13 (Remote Network Interaction), quoted: "Notwithstanding any other provision of this License, if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network (if your version supports such interaction) an opportunity to receive the Corresponding Source of your version by providing access to the Corresponding Source from a network server at no charge, through some standard or customary means of facilitating copying of software."

## Verdict (private app today, possible SaaS later; not legal advice)
A) Re-implement patterns from scratch — SAFEST. §13 duty triggers only "if you modify the Program". Self-written code reproducing observed behavior/layout = no copy, no modification → no notice or network-source duty, ever. Don't paste code/assets/CSS verbatim while re-implementing.
C) npm dependency — unavailable for Plane code (nothing published; @plane/editor private). Viable variant: depend on Plane's upstream stack (@tiptap/core MIT — only notice preservation) + build chrome yourself = option A for UI. Second-safest.
B) Copy files verbatim keeping notices — riskiest for this roadmap. Private internal use today: practically trivial duties. The moment it's offered as a service, §13 requires offering Corresponding Source of your version to ALL remote users at no charge — boundary contestable, could be argued to reach substantially the whole combined work. Choose only if full source disclosure of the combined work is acceptable at launch.

## Leads
plane.so/legal 404; check plane.so/terms if branding "Plane" ever used. License-check yjs/@hocuspocus/provider/tiptap-markdown/prosemirror-* before adoption. docs.plane.so self-hosting stance on AGPL.

## Not found
No commercial/EE license, no NOTICE, no CLA/DCO. No Plane npm package of any kind. No AGPL mention on pricing page.
