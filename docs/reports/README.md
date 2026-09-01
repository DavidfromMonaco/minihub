# Rapports archivés

Journal des investigations et des passes de correction menées sur MiniHub.
Ces documents sont **historiques** : ils décrivent l'état du code au moment de
leur rédaction, pas nécessairement l'état actuel. La référence vivante est
`README.md` à la racine et `docs/ENGINE2_ARCHITECTURE.md`.

Les chemins `artifacts/...` cités dans ces rapports sont relatifs à la racine du
dépôt. Les captures, JSON et rendus audio effectivement cités ont été conservés ;
les rendus non cités et les profils Chromium jetables ont été purgés.

## Moteur audio — de Tracktion à Engine 2

L'arc principal du projet : évaluation d'un moteur tiers, rejet, puis
construction du moteur PortAudio/VST3 aujourd'hui compilé dans
`native/audio-engine/src/engine2/`.

| Date | Document | Sujet |
|---|---|---|
| 2026-08-24 | [TRACKTION_ENGINE_FEASIBILITY.md](TRACKTION_ENGINE_FEASIBILITY.md) | Faisabilité de Tracktion Engine |
| 2026-08-24 | [TRACKTION_ENGINE_PROTOTYPE_REPORT.md](TRACKTION_ENGINE_PROTOTYPE_REPORT.md) | Rapport du prototype Tracktion Engine |
| 2026-08-24 | [ENGINE2_PROTOTYPE_REPORT.md](ENGINE2_PROTOTYPE_REPORT.md) | Engine 2 — rapport final du prototype |
| 2026-08-24 | [ENGINE2_MINIHUB_INTEGRATION_REPORT.md](ENGINE2_MINIHUB_INTEGRATION_REPORT.md) | Intégration définitive d'Engine 2 |
| 2026-08-24 | [ENGINE2_REALTIME_OUTPUT_BUFFER_REPORT.md](ENGINE2_REALTIME_OUTPUT_BUFFER_REPORT.md) | Correction du tampon de sortie temps réel |
| 2026-08-24 | [FINAL_VST3_BUFFER_BRIDGE_REPORT.md](FINAL_VST3_BUFFER_BRIDGE_REPORT.md) | Réécriture du bridge audio VST3 |
| 2026-08-31 | [AUDIO_CRACKLE_ROOT_CAUSE_REPORT.md](AUDIO_CRACKLE_ROOT_CAUSE_REPORT.md) | Craquements audio : cause racine et correctifs |

## Gain, sommation et sortie master

| Date | Document | Sujet |
|---|---|---|
| 2026-08-23 | [GAUNTLET_MASTER_OUTPUT_CLIPPING_REPORT.md](GAUNTLET_MASTER_OUTPUT_CLIPPING_REPORT.md) | Master Output / écrêtage numérique |
| 2026-08-23 | [GAUNTLET_PER_NODE_VST_GAIN_STAGING_REPORT.md](GAUNTLET_PER_NODE_VST_GAIN_STAGING_REPORT.md) | Gain staging VST par nœud |
| 2026-08-24 | [GAUNTLET_LINEAR_FLOAT_SUMMATION_REPORT.md](GAUNTLET_LINEAR_FLOAT_SUMMATION_REPORT.md) | Refonte gain et sommation flottante |
| 2026-08-24 | [CROSS_TRACK_AUDIO_ISOLATION_REPORT.md](CROSS_TRACK_AUDIO_ISOLATION_REPORT.md) | Isolation audio inter-pistes |

## Séquenceur, Clip Editor et export

| Date | Document | Sujet |
|---|---|---|
| 2026-08-23 | [SEQUENCER_IMPLEMENTATION_REPORT.md](SEQUENCER_IMPLEMENTATION_REPORT.md) | Implémentation du séquenceur (+ limites documentées) |
| 2026-08-23 | [SEQUENCER_GAUNTLET_REPORT.md](SEQUENCER_GAUNTLET_REPORT.md) | Gauntlet séquenceur |
| 2026-08-23 | [GAUNTLET_SEQUENCER_CLIP_EDITING_REPORT.md](GAUNTLET_SEQUENCER_CLIP_EDITING_REPORT.md) | UX, édition de clips et quantification |
| 2026-08-23 | [GAUNTLET_SEQUENCER_CLIP_EDITOR_TRANSPORT_REPORT.md](GAUNTLET_SEQUENCER_CLIP_EDITOR_TRANSPORT_REPORT.md) | Transport du Clip Editor |
| 2026-08-23 | [GAUNTLET_SEQUENCER_EXPORT_FORMATS_TRANSPORT_REPORT.md](GAUNTLET_SEQUENCER_EXPORT_FORMATS_TRANSPORT_REPORT.md) | Formats d'export et isolation du transport |
| 2026-08-24 | [GAUNTLET_SEQUENCER_EXPORT_MIDI_ROUTING_REPORT.md](GAUNTLET_SEQUENCER_EXPORT_MIDI_ROUTING_REPORT.md) | Séquenceur / export / routage MIDI |
| 2026-08-24 | [GAUNTLET_AUDIO_ENGINE_EXPORT_ARCHITECTURE_REPORT.md](GAUNTLET_AUDIO_ENGINE_EXPORT_ARCHITECTURE_REPORT.md) | Architecture export multipiste / bounce offline |
| 2026-08-24 | [SEQUENCER_AUDIO_MIDI_CORRECTNESS_REPORT.md](SEQUENCER_AUDIO_MIDI_CORRECTNESS_REPORT.md) | Correction audio/MIDI du séquenceur |

## Hôte VST3

| Date | Document | Sujet |
|---|---|---|
| 2026-08-23 | [GAUNTLET_VST_SILENT_PLUGIN_DIAGNOSTIC_REPORT.md](GAUNTLET_VST_SILENT_PLUGIN_DIAGNOSTIC_REPORT.md) | Diagnostic des VST3 muets |

## Historique du projet

| Date | Document | Sujet |
|---|---|---|
| 2026-08-18 | [REFACTOR_PASS_2.md](REFACTOR_PASS_2.md) | Passe de nettoyage 2 — journal de progression |
| 2026-08-19 | [MiniHub_Handoff_2026-08-18_full.md](MiniHub_Handoff_2026-08-18_full.md) | Handoff / contexte projet |
| 2026-08-24 | [GAUNTLET_FULL_APPLICATION_AUDIT_REPORT.md](GAUNTLET_FULL_APPLICATION_AUDIT_REPORT.md) | Audit applicatif complet |
