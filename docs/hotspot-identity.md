# Scoped native hotspot identity

Contract decision for pl-da6d, trellis-9302. Producer adoption is delivered by
trellis-3d6b. Scoped matching is the subsequent trellis-7cfd milestone; the
comparison matrix below specifies that matcher's required behavior.

Identity v1 is optional on the general finding contract, but belongs only to
`complexity.hotspot`. Absence means historical provenance, never ambiguity.
Modern producers must emit either `identified` or `ambiguous` on every hotspot.
An identified function carries source set, outermost-first named scopes, and
function kind/name/member mode. The finding's relative path completes identity.
Serialize keys as JSON arrays of version, kind, path, source set, scope tuples
and function tuple; never concatenate delimiters or serialize unordered objects.
Locations, rank, ordinals, body hashes, display names and CC are not keys.

| Function form or edit | Identity / comparison expectation |
| --- | --- |
| Named declaration | Declared name and function kind in named ancestry |
| Variable-bound arrow/expression | Variable binding name; expression's local name does not replace its binding |
| Nested named function | Includes every enclosing function tuple |
| Class A.run / B.run | Distinct class scopes; adding B.run is new |
| Variable/property-bound object method | Includes named object ancestry; distinct objects stay distinct |
| Static / instance method | Distinct member mode, including enclosing method scopes |
| Constructor | Kind constructor, name constructor, instance mode |
| Getter / setter | Distinct function kinds even with the same name |
| Overload signatures | No identity or finding without a body; implementation alone participates |
| Anonymous callback or unbound expression | Ambiguous: anonymous |
| Computed function or enclosing container name | Ambiguous: computed-name, including literal computed names |
| Anonymous class/object ancestor | Ambiguous: unnamed-scope unless directly variable/property bound |
| Non-body lexical block, loop or catch ancestor | Ambiguous: block-scope; never number blocks by source order |
| Duplicate declaration/container identity | All colliding functions and descendants ambiguous: duplicate, even if only one is a hotspot |
| Namespace | Named namespace scope; duplicate namespace declarations conservatively ambiguous |
| Rename / file move / source-set change | Different identity: resolved plus new |
| Comment, blank line, unrelated sibling, same-scope reorder | Same identity, persistent with line shift |
| Body/CC edit of a stable named function | Same identity; metric delta separate |

Scope ambiguity propagates to descendants. Ordinary function-body blocks do
not introduce an extra scope. Class static blocks are ambiguous block scopes.
Private names retain their `#` prefix. Literal property names use their static
text. Parentheses and assignment expressions do not invent contextual names:
only direct variable declarations, property assignments and class property
initializers provide bindings. If several ambiguity causes apply, choose the
first outermost cause; at the same node prefer computed-name, anonymous or
unnamed-scope, then block-scope. Duplicate detection runs after ancestry and
marks otherwise identified collisions; it never removes inventory entries.

## Version and reader transition

The producer emits report schema **1.2.0**, analyzer
**0.2.2**, and native `trellis.complexity` tool/adapter **0.2.2**. Identity
version is **1.0.0**. Scoring stays **0.2.0-provisional** with unchanged weights.
Report readers retain schemas 1.0.0 and 1.1.0 and reject
identity fields in those historical schemas. Schema 1.2.0 requires valid
identity on every native hotspot. Historical schemas never synthesize identity.
Unknown identity versions and malformed identities are operational read errors,
not silent legacy fallback. Unknown report schemas remain read errors.

| Pair provenance | Required behavior |
| --- | --- |
| Modern / modern, same verified unique key once per side | Persistent, record lineShift |
| Modern / modern, different keys | New / resolved |
| Modern ambiguous on either side | New / resolved, even in a 1:1 file group |
| Duplicate key on either side | Entire key group new / resolved; preserve every occurrence |
| Historical / historical | Existing kind+path 1:1 fallback; n:m remains new/resolved |
| Modern / historical | Report schema/analyzer mismatch refuses scored comparison; standalone finding comparison never pairs them |
| Unknown identity version | Reject at read boundary; no matching fallback |
| Any scored-basis incompatibility | Refuse comparison before finding matching, regardless of matching identities |

Historical fallback is compatibility behavior, not a claim of verified function
identity. Modern users need a fresh baseline. Other finding kinds and provider
evidence retain their current matching semantics. No Git, source reread or
filesystem access is needed to compare saved artifacts.

## Producer validation

The syntax inventory derives identity by traversing its existing parsed AST;
no parse, filesystem, Git or process access is added. Named scope collisions
are registered across all functions before identities are resolved, including
non-hotspot functions. Display names and body measurements remain independent.
`src/syntax/identity.test.ts` exercises the function-form matrix;
`src/metrics/hotspot-identity.test.ts` covers source-set propagation, collisions
below the hotspot threshold, modern round trips and rejected identity payloads.

Against pre-producer commit `4730933`, both audit cores were run over each of
the eleven `corpus/fixtures` directories, using the same local dependencies.
All native metrics, scores, safeguards, coverage, completeness and findings
(with only the new identity field removed) were deeply equal. No golden
artifacts or scoring constants changed. This establishes measurement parity;
it does not certify the later duplication replacement.
