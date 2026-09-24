# Salesforce Project

## Code Search & Data — Use rtk-sf First (Required)

This project is indexed by **rtk-sf**. Always use the MCP tools before reading raw files or calling sf CLI:

| Task | Tool to call |
|---|---|
| Find a component by name or keyword | `search_codebase(query)` |
| Read a component spec / fields / methods | `query_compressed_spec(component_name)` |
| Blast-radius before editing | `get_relations(component_name)` |
| List all Apex classes / objects / flows | `list_components(type)` |
| Write discovered business logic back | `annotate_component(component_name, key, value)` |
| Read an Apex class before editing (surgical) | `get_class_skeleton(component_name, focus_methods)` |
| Deploy / retrieve / run tests silently | `sf_command(action, target_org, ...)` |
| Get object field list for data creation | `get_object_schema(object_name)` |
| Inspect existing records (sample only) | `soql_query(query, target_org, sample_size)` |
| Compact a bilingual prompt before sending | `compact_prompt(text)` |
| Dry-run Apex code before deploy | `validate_apex(code)` |
| Dry-run SOQL before executing | `validate_soql(query)` |
| Extract text from a screenshot/image | `extract_image_text(image_path)` |
| View token/dollar savings this session | `get_roi_stats()` |

**Never** do these directly — use the tool instead:
- Read a raw .cls file       → `get_class_skeleton`
- sf sobject describe        → `get_object_schema`
- sf data query              → `soql_query`
- sf project deploy start    → `sf_command(action="deploy")`
- Read an inline pasted image with native vision → ask for the file path, then `extract_image_text(path)`

**Image / screenshot rule:** `extract_image_text` requires a file path on disk.
If the user pastes an image inline without a path, reply:
"To save vision tokens, please share the file path (e.g. `~/Downloads/screenshot.png`) so I can run local OCR instead."

If search returns no results, re-index with: `python3 -m rtk_sf index`
Do NOT use `npx rtk-sf` — rtk-sf is a Python package, not npm.

