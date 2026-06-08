obsolete JSON extraction logic removal as pipe based works better. escaped newline support required in custom piped extraction - DONE

overengineered config.js that recreates config.json by using firstDefined() with each JSON KEY and an env variable ----- instead plain env injection using placeholders and string replace would work better - DONE

Graph Schema enforce in node edits , typeahead - DONE

Readme.md sync , MEMORY BANK implementation for multi agent (planner , developer) orchestration - DONE

information , description , relation , node description --- system prompt must direct LLM for what kind of info goes where via graph schema. - DONE

edges ordering / sequence

TESTS

node dragging issue. link select then node dragging issue.

HITL must not save metadata to DB.

CLI structure causing issue ? maintainability issue ? --- DONE. not an issue.

spaces feature --- different knowledge spaces or like Projects. architecture required. separate customizable system prompt , DBs, Vector Collections , etc

Leveraging KG -- agentic ASK -- template CYPHER queries for LLM to perform. Microsoft GraphRAG , microsoft graphrag BLOG techniques , AgentiGraph , flexible graphrag multi agent research paper.
Leveraging Vector -- all systems worldwide use vectorRAG , inherent nature of brain is vector whereas notebooks and rest other tools act like Graph. Truly leveraging HybridRAG

Past informmation versioning , queryable

BM25 --- VVIMP

IDEA ------ start with VectorRAG over documents. Users thumb -> info ingested into KG.

Diffuse HITL , HITL & ingestion enhancements - agentic - successive prompt produce more triplet or modify existing HITL i.e. HITL itself assisted by AI not fully manual. === Lowering HITL friction.