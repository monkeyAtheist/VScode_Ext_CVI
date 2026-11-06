## 0.7.43

- Ajoute une page **External Compiler** dans **CVI Project Settings** avec choix du moteur `Native LabWindows/CVI (compile.exe)` ou `External Microsoft Visual C++ (MSVC)`.
- Le mode MSVC reprend la configuration CVI active (Debug/Release/Debug64/Release64 ou custom reconnue) pour l'architecture, les defines, include paths, prefix header et chemin de sortie.
- Découvre automatiquement `vcvarsall.bat` via `VSINSTALLDIR`/`vswhere.exe`, avec override manuel possible.
- Compile les sources C avec `cl.exe` dans `.vscode/cvi-external-build/...`, puis utilise `link.exe` pour EXE/DLL ou `lib.exe` pour une static library.
- Ajoute automatiquement `CVI\include`, `extlib\msvc|msvc64\cvirt.lib` et `cvisupp.lib`.
- Consomme les fichiers générés par **Build > External Compiler Support** (UIR callbacks / Project Symbols) lorsqu'ils existent, sans tenter de reconstruire ce format propriétaire.
- Signale les prérequis `InitCVIRTE` et `CloseCVIRTE`, les sources/libs/objets manquants et les fichiers UIR sans table de callbacks générée.
- Les builds Debug externes utilisent `/Z7` et `/DEBUG` avec PDB, puis la commande **Build and Debug with External MSVC in VS Code** lance `cppvsdbg`.
- Le débogage natif CVI force explicitement le moteur natif `compile.exe`, même si le projet est configuré en MSVC.
- Les anciens `labwindows-cvi-build.json` sans champ `externalBuild` restent automatiquement en moteur CVI natif.
- Ajoute 23 tests ciblés External Compiler ; la non-régression cumulative v0.7.31→v0.7.43 atteint 261/261 contrôles.

## 0.7.42

- Ajoute une page **Autocompletion** dédiée dans le panneau visuel **CVI Project Settings**.
- Les cinq profils `Hybrid`, `Native`, `Native + CVI Signature Help`, `CVI API Assist` et `Custom` sont sélectionnables directement depuis cette page.
- Le mode Custom expose visuellement les quatre composants indépendants : provider CVI PM, symboles projet, API LabWindows/CVI embarquée et Signature Help immédiat.
- Ajoute un aperçu dynamique du comportement effectif avant sauvegarde (completion CVI PM, symboles projet, API CVI, Signature Help).
- Les réglages d'autocomplétion sont sauvegardés avec le bouton **Save settings** du panneau et restent stockés au niveau workspace VS Code, indépendamment de Debug/Release/32/64 bits.
- La page fournit également **Sync IntelliSense** et **Diagnose IntelliSense** sans modifier les réglages `C_Cpp.*` de Microsoft C/C++.
- Le profil **Native + CVI Signature Help** est mis en avant comme compromis pour éviter les doublons de completion tout en conservant les paramètres instantanés.
- Le sélecteur Quick Pick v0.7.41 reste disponible ; la page visuelle et la commande pilotent les mêmes clés de configuration.
- Ajoute 14 tests ciblés de la page visuelle ; la non-régression cumulative v0.7.31→v0.7.42 atteint 238/238 contrôles.

## 0.7.41

- Ajoute `labwindowsCvi.autocompleteProfile` avec cinq profils génériques : `hybrid`, `native`, `nativeSignature`, `cviApi` et `custom`.
- Le profil **Hybrid** conserve le comportement v0.7.40 : completion projet + API CVI embarquée + Signature Help CVI PM, tout en laissant les autres providers C/C++ contribuer normalement.
- Le profil **Native** retire complètement les providers de completion/signature CVI PM sans modifier les réglages Microsoft C/C++ ni ceux d'une autre extension.
- Le profil **Native + CVI Signature Help** laisse la liste de completion au provider C/C++ natif tout en conservant l'affichage immédiat des prototypes/paramètres de CVI PM après `(` et `,`.
- Le profil **CVI API Assist** n'ajoute que les fonctions du pack API LabWindows/CVI à la completion ; les symboles projet restent à la charge du provider natif, tandis que Signature Help reste disponible.
- Le profil **Custom** conserve les réglages fins historiques et ajoute `labwindowsCvi.enableSupplementalCviApiCompletion` pour activer/désactiver séparément les symboles de l'API CVI embarquée.
- Ajoute la commande `LabWindows/CVI: Select Autocompletion Profile` avec Quick Pick ; le réglage est enregistré au niveau workspace lorsqu'un workspace est ouvert, sinon au niveau utilisateur.
- Les anciens booléens explicitement configurés avant v0.7.41 restent honorés automatiquement comme profil Custom tant qu'aucun nouveau profil n'a été choisi explicitement.
- Aucune configuration Microsoft C/C++ (`C_Cpp.*`) n'est modifiée par le sélecteur de profil ; CVI PM contrôle uniquement ses propres contributions.
- Ajoute des tests d'API génériques et vérifie explicitement l'absence de règles runtime codées en dur pour une bibliothèque/projet particulier.
- Ajoute 22 tests ciblés de profils d'autocomplétion ; la non-régression cumulative v0.7.31→v0.7.41 atteint 224/224 contrôles.

## 0.7.40

- Ajoute un `SignatureHelpProvider` CVI PM pour afficher immédiatement le prototype et les paramètres des fonctions du projet et du pack CVI lors de la saisie de `(` puis mettre à jour le paramètre actif sur `,`.
- Réutilise l’index de symboles projet déjà disponible au lieu d’attendre la fin de l’analyse sémantique Microsoft C/C++, supprimant le délai observé avant l’apparition des paramètres.
- Préfère les déclarations provenant des headers (`.h/.hpp/.hh/.hxx`) aux définitions source lorsqu’une fonction existe aux deux endroits, afin de conserver le prototype public et les noms d’arguments les plus précis.
- Conserve les surcharges distinctes pour Signature Help tout en gardant une seule entrée de completion par nom de fonction.
- Gère le suivi du paramètre actif à travers les appels imbriqués, parenthèses/crochets/accolades, chaînes et commentaires.
- Gère correctement les paramètres pointeurs de fonction/callback et les signatures contenant des attributs comme `__declspec(...)`.
- Les suggestions complémentaires acceptent désormais `(` comme caractère de validation afin que la transition completion → aide aux paramètres soit immédiate.
- Ajoute `labwindowsCvi.enableSupplementalProjectCompletion` pour masquer uniquement les symboles projet du provider complémentaire lorsque Microsoft C/C++ affiche déjà la même entrée, tout en conservant le Signature Help immédiat.
- Ajoute `labwindowsCvi.enableSupplementalSignatureHelp`, activé par défaut et indépendant du provider de completion complémentaire.
- Ajoute 23 tests ciblés Signature Help/completion ; la non-régression cumulative v0.7.31→v0.7.40 atteint 202/202 contrôles.

## 0.7.39

- Corrige le validateur `.prj` à partir de projets CVI réels : `Number of Files` peut être temporairement désynchronisé du nombre de sections sans empêcher CVI d’ouvrir/build le projet.
- N’impose plus que les sections `[File NNNN]` soient contiguës ni physiquement triées. Les identifiants de fichier CVI sont stables et peuvent contenir des trous ; l’ordre des blocs dans le fichier est indépendant de leur numéro.
- `Add Existing Files` insère désormais le nouveau bloc après le dernier bloc `[File]` existant sans déplacer les sections natives, et choisit un nouvel identifiant à partir du maximum existant.
- `Remove File` et `Remove Folder -> Remove references` ne renumérotent plus les autres fichiers ; seul `Number of Files` est mis à jour lorsque l’ensemble des références change.
- Les projets CVI anciens qui utilisent `Folder` sans `Folder Id` ne sont plus signalés comme corrompus. Les références physiques absentes (clé USB, réseau, ancien disque) ne déclenchent plus une proposition de Repair à chaque ouverture.
- Le Repair `.prj` devient volontairement conservateur : il ne renumérote plus les fichiers, n’aplatit plus les dossiers, ne réécrit plus les chemins, ne convertit plus les types de fichier et n’ajoute plus de `Folder Id` sur la seule base d’hypothèses CVI PM.
- Le garde-fou avant écriture ne bloque plus Replace/Add à cause d’un layout historique accepté par CVI ; il conserve uniquement les protections déterministes telles que les sections `[File NNNN]` dupliquées.
- Ajoute des tests de régression construits à partir des structures observées dans le projet MCO_ACS et ses backups natifs CVI.

## 0.7.38

- Ajoute une vraie commande **Close Current Workspace or Project** qui décharge l’état CVI, détruit les watchers natifs et oublie le dernier workspace mémorisé.
- Décharge automatiquement un workspace/projet CVI lorsque son fichier natif disparaît ou lorsque le dossier VS Code qui le contient est retiré, au lieu de conserver une arborescence obsolète en mémoire.
- Versionne les watchers `.cws/.prj` avec une génération et annule les timers de refresh appartenant à un ancien workspace afin qu’un événement retardé ne puisse plus rafraîchir un projet nouvellement chargé.
- Le panneau **Build Settings** suit désormais le workspace courant et se ferme si son projet n’en fait plus partie ; chaque sauvegarde revérifie l’appartenance du `.prj` avant toute écriture.
- Les synchronisations IntelliSense différées utilisent un epoch : une synchronisation devenue obsolète après un changement de projet/workspace/configuration est abandonnée avant l’écriture de `c_cpp_properties.json`.
- Le binding DDE natif est libéré dès que le contexte CVI change lorsqu’aucune exécution n’est active. Si un programme reste Running/Suspended, le binding PID précédent est conservé uniquement pour Pause/Continue/Stop.
- `CviBuildService` et `CviProjectSettingsService` sont maintenant disposables : les processus `compile.exe`, Build Steps shell et timers de suivi de log encore actifs sont arrêtés lors d’un reload/désactivation.
- Les providers Workspace/File Symbols possèdent désormais explicitement leurs subscriptions/EventEmitters et les libèrent à la désactivation.
- Le module CVI Libraries rattache ses Webviews, son TreeDataProvider et ses timers de rendu au `ExtensionContext`, évitant des callbacks de rendu après reload.
- Ajoute 30 tests ciblés de cycle de vie ; la non-régression cumulative v0.7.31→v0.7.38 atteint 160/160 contrôles.

## 0.7.37

- Lie désormais chaque session native CVI à un **PID précis** au lieu de supposer qu’un service DDE `cvi/system/status` unique est disponible.
- Le bridge DDE utilise `DdeConnectList` / `DdeQueryConvInfo` pour identifier le processus serveur et refuse toute connexion ambiguë lorsque plusieurs instances CVI répondent sans PID cible.
- Une instance CVI existante n’est réutilisée que si son identité peut être vérifiée ; les workspaces multi-projets utilisent une instance dédiée afin de ne pas piloter un projet actif différent en mémoire.
- Le PID retourné lors du lancement de `cvi.exe` est conservé et réutilisé pour tous les probes DDE, la session persistante, le monitoring de fin d’exécution et le contrôle de fenêtre.
- `native/cvi-window-control.ps1` ne minimise plus toutes les fenêtres CVI : il exige le PID exact de l’instance liée.
- Le fallback ActiveX refuse désormais plusieurs processus CVI simultanés et vérifie le PID attendu lorsqu’un binding déterministe existe.
- Les commandes Pause/Continue/Stop tentent une reconnexion unique de la session DDE persistante au même PID si le processus bridge a disparu.
- Build/Run refusent explicitement de continuer lorsque CVI attend une réponse utilisateur dans une boîte de dialogue modale.
- La perte du bridge DDE met à jour l’état du dashboard et conserve un diagnostic exploitable au lieu de laisser une session faussement connectée.
- La synchronisation des breakpoints `.cws` utilise maintenant la garde de concurrence optimiste afin de ne pas écraser une sauvegarde CVI simultanée.
- Supprime les réglages et méthodes DAP morts restés depuis l’ancien prototype 0.6.24 ; le débogage détaillé reste volontairement délégué à la fenêtre native CVI.

## 0.7.36

- Étend les Target Settings natifs aux configurations personnalisées détectées par `Config Name`, sans dépendre du nom interne de leur section `.prj`.
- Résout et écrit le chemin de sortie exact `Executable File_<nom de configuration>` pour les configurations custom, y compris lorsque leur nom contient des espaces.
- Gère par configuration personnalisée les paramètres de cible/linker réellement sérialisés : titre, icône, runtime support/binding, manifest, map, console, UIR embarquées, modules forcés, DLL, type information, version info et signature.
- Préserve et expose `DLL Import Library Choice` comme valeur CVI native libre afin de ne pas imposer une énumération non documentée.
- Accepte les deux formes rencontrées pour les exports DLL (`Export File1` et `Export File 0001`) et corrige ainsi la relecture des listes écrites par CVI PM.
- Étend l'écriture des paramètres compilateur aux configurations personnalisées reconnues tout en conservant l'isolation vis-à-vis de Debug/Release/Debug64/Release64.
- Étend les Run/Debug et Build Options custom du `.cws` uniquement lorsqu'une section native correspondante existe déjà ; CVI PM refuse de créer artificiellement une structure custom non observée.
- Le panneau Build Settings permet désormais de sélectionner directement une configuration personnalisée reconnue et affiche ses Target/Compiler/Run Settings.
- Les Build Steps d'une configuration custom restent la propriété de CVI/`compile.exe -config=<nom>` et ne sont pas réécrits par le panneau.
- `Run` utilise les Run Settings propres à la configuration custom active lorsqu'ils sont présents dans le workspace.
- Corrige une double écriture accidentelle du `.prj` dans le setter Target Settings standard.

## 0.7.35

- Durcit les options propres aux fichiers CVI : `Exclude File from Build` n'est proposé/accepté que pour les modules de build éligibles (sources C, bibliothèques, DLL/OBJ) et reste refusé pour les headers, function panels et UIR.
- Conserve `Compile Into Object File` strictement réservé aux sources C et expose désormais les métadonnées natives `Project Flags` et `Path Force Path Absolute` dans le modèle fichier.
- Détecte les configurations de build personnalisées sérialisées dans le `.prj` par leurs champs natifs (`Config Name`, `Is 64-Bit`, `Is Release`) sans dépendre d'un nom de section non documenté.
- Lit les options compilateur d'une configuration personnalisée reconnue (defines, C99, warnings, architecture, etc.) et les propage à IntelliSense.
- Synchronise le nom exact d'une configuration personnalisée avec `Build Configuration` du `.cws` et l'utilise automatiquement pour `compile.exe -config=<nom>`, même sans override VS Code explicite.
- Le sélecteur de configuration affiche les configurations personnalisées détectées en plus de Debug/Release/Debug64/Release64.
- Les configurations personnalisées reconnues déterminent correctement l'architecture x86/x64, le profil Debug/Release et le comportement du débogueur natif.
- La résolution du target essaie d'abord une sortie nommée propre à la configuration personnalisée puis retombe prudemment sur le mode standard équivalent.
- Signale les incohérences entre `Num Custom Build Configs` et le nombre de sections custom reconnues sans modifier automatiquement le projet.
- Ajoute une lecture non destructive de la section `External Compiler Support` (UIR callbacks, LoadExternalModule, project symbols) afin de préserver ce workflow tiers sans le confondre avec le build natif `compile.exe`.
- Les menus Include/Exclude du Tree suivent maintenant l'éligibilité réelle du type de fichier au lieu d'être limités arbitrairement aux seuls `.c`.

## 0.7.34

- Synchronise le fichier `.vscode/c_cpp_properties.json` avec le **projet CVI actif** et sa configuration native `Debug`, `Release`, `Debug64` ou `Release64`.
- Bascule `intelliSenseMode` entre `windows-clang-x86` et `windows-clang-x64` selon la configuration CVI active.
- Propage les `Compiler Defines` `/DNAME` et `/DNAME=value` du `.prj` vers `defines`, tout en ignorant les tokens invalides déjà signalés par le validateur.
- Ajoute les macros CVI/Windows d’architecture nécessaires à l’analyse des headers (`_NI_mswin32_` / `_NI_mswin64_`, `_WIN64` en x64) et `NDEBUG` pour les configurations Release.
- Ajoute `_CVI_CONFIGURATION_NAME_` pour les formats CVI 2013+.
- Propage les `Include Paths` projet en conservant leur priorité devant les headers système CVI/Windows.
- Mappe le Prefix Header natif sur `forcedInclude` lorsque `Precompile Prefix Header` est activé.
- Remplace le `c11` générique par `c89` ou `c99` selon `Enable C99 Extensions` pour mieux suivre le mode de compilation CVI.
- Isole le `includePath` sémantique au projet actif afin d’éviter qu’un header homonyme d’un autre projet du workspace soit résolu par erreur. `browse.path` conserve en revanche l’ensemble des projets pour la recherche globale de symboles.
- Supprime le glob récursif `${workspaceFolder}/**` du `includePath` géré, source potentielle de résolutions différentes de `compile.exe`.
- Le diagnostic IntelliSense affiche désormais projet actif, configuration native, architecture, standard C, defines, includes et prefix header effectifs.
- Les changements de projet actif, de configuration native ou de paramètres Compiler & Linker continuent à déclencher automatiquement la régénération via le rafraîchissement du workspace.
- Les configurations CVI personnalisées non sérialisées restent explicitement signalées : CVI PM utilise alors le mode standard de secours pour IntelliSense sans prétendre avoir désérialisé les options custom.

## 0.7.33

- Ajoute une page **Compiler & Linker** aux paramètres de build pour les options réellement sérialisées par configuration CVI.
- Lit et écrit par configuration les defines, convention d’appel, prototypes/retours, warnings historiques, C99, stack et image base sans propager arbitrairement les valeurs aux autres modes.
- Préserve la compatibilité entre générations : les clés plus récentes (`Optimization Level`, profils de warnings, OpenMP, Stack Reserve/Commit) ne sont modifiées que si le `.prj` les sérialise déjà.
- Ajoute la gestion ordonnée des `Include Paths`, du prefix header et de l’option de compatibilité CVI 5.0 au niveau projet.
- Ajoute la lecture/écriture des options de build/debug natives du `.cws` par projet et configuration (browse info, runtime uninitialized warning, profile, debugging level, execution trace, batch build).
- Ajoute une validation non bloquante des defines CVI et de la cohérence `Is 64-Bit` / `Is Release`; les anomalies apparaissent dans l’éditeur et dans le rapport de build.
- Le préflight Build/Compile File affiche désormais un résumé des defines, include paths, warnings et optimisation lorsque ces informations sont disponibles.
- Préserve les flags fichier `Exclude` / `Compile Into Object File` lors des modifications de paramètres compilateur.

## 0.7.32

- Sépare correctement les configurations CVI nommées des modes standards : `-config=<nom>` remplace désormais `-debug/-release/-debug64/-release64` au lieu d’être combiné avec eux.
- Applique une configuration nommée uniquement au projet explicitement demandé ; les projets dépendants conservent leur propre configuration native du `.cws`.
- `Compile File` conserve les options du mode natif du projet et n’applique pas arbitrairement une configuration nommée de projet complet.
- Filtre dans `extraCompilerArguments` les options déjà pilotées par CVI PM (`-debug`, `-release`, `-debug64`, `-release64`, `-config`, `-rebuild`, `-log`) afin d’éviter les lignes de commande contradictoires.
- Laisse `compile.exe` exécuter seul les Build Steps lorsqu’une configuration CVI nommée est utilisée, évitant une double exécution des actions de secours de l’extension.
- Résout les chemins relatifs des diagnostics compilateur par rapport au dossier du `.prj` afin que la vue Problems pointe vers le bon fichier.
- Détecte explicitement les échecs de Build Steps et fournit un diagnostic exploitable ; un code de sortie non nul sans diagnostic reconnu génère désormais une erreur synthétique au lieu d’afficher `Errors: 0`.
- Supprime la duplication du stdout/stderr/log dans la Build Trace et conserve à la place un résumé des captures et le chemin du log CVI.
- Étend la garde de concurrence optimiste aux Target Settings, Run Settings, Build Actions et changement de Target Type afin de ne pas écraser une sauvegarde CVI concurrente.

## 0.7.31

- Synchronise le mode de build avec la configuration native propre à chaque projet du workspace CVI (`Debug`, `Release`, `Debug64`, `Release64`).
- Utilise le mode natif de chaque dépendance lors des builds multi-projets au lieu de forcer un mode VS Code global unique.
- Sécurise le débogage natif : une configuration Release est convertie explicitement vers Debug/Debug64 avant le preflight et le lancement CVI.
- Résout les chemins relatifs `Program Name` et `Working Directory` par rapport au dossier du `.prj`.
- Durcit le lancement des exécutables : validation fichier/dossier et gestion de l’événement `spawn` en erreur.
- Rend `Clean` sensible à la configuration : les bases de symboles Debug ne sont plus supprimées lors d’un Clean Release et les import libraries DLL ne sont plus devinées/supprimées à risque.
- Corrige le validateur `.cws` : `Number of Opened Files` est un état de session de l’IDE CVI et n’est plus assimilé au nombre de sections `[File NNNN]`.
- Préserve `Number of Opened Files` lors des mutations de références workspace.
- Exclut réellement les source maps `out/**/*.map` du VSIX.

## 0.7.11

- Supprime les packs internes liés à un environnement Lua propriétaire et à un ancien séquenceur privé.
- Nettoie le menu d’ajout des packs embarqués : Lua ne propose plus que Lua standard, Lua industriel/banc de test et Stormworks.
- Ajoute un nettoyage automatique des copies obsolètes déjà déployées dans le stockage global VS Code.
- Met à jour les références historiques du README et du changelog pour éviter d’exposer ces packs retirés.

# 0.7.4
## 0.7.9

### Changed

- Updated the embedded Qt library pack from JC Lib 0.8.36.
- Added independent embedded Qt starters: Qt Language, Qt QML / Qt Quick, Qt Multimedia, and Qt SQL & Test.
- Updated the Qt structured category routing used by embedded pack import/merge/save operations.
- Synchronized the Qt environment in the default embedded pack.

### Not changed

- C, C++, Git and system scripting packs were not modified because the supplied JC_LIB archive only contained summary/validation material for those areas, not full pack JSON or an applicable patch.

- Synchronisation des structures de packs embarqués depuis JC Lib 0.8.27.
- Mise à jour des packs structurés C, C++, Lua, SDL, Embedded, OpenCV, Web, Windows API / Devices et default pack.
- Ajout des nouveaux packs embarqués Assembly, Visual Basic / VBA, SDL2 séparé et SDL3 séparé.
- Mise à jour du menu d’ajout de packs : SDL2/SDL3, Assembly, VBA, Meson, Arduino Mega 2560, Microchip PIC, Texas Instruments MSP, et Windows API / Devices unifié.


## 0.6.39

- Integrated the CPM 0.2.48 color value picker into the CVI editor context menu.
- Added `CVI > Insert color value` with color picker, brightness slider, alpha preview, presets and formatted insertion.
- Adapted output formats for CVI/C usage: `#RRGGBB`, `0xRRGGBB`, decimal RGB, `rgb(...)`, `rgba(...)`, channel lists, C brace initializers, `MakeColor(r, g, b)` and `RGB(r, g, b)`.

## 0.6.38

- Synced the embedded JC Lib multi-select picker fix from standalone JC Lib 0.8.9.
- Enum-backed select parameters now accept generated combined values such as `FLAG_A | FLAG_B` and immediately update the generated call preview.
- The advanced picker still preserves single-choice behavior for normal enum parameters.

# 0.6.37

- Added CVI-compatible C Python and Lua execution bridge bundles.
- Added generic Python worker and Lua worker protocol starters.
- Synced C communication bundle Doxygen headers and examples from the C/C++ Project Manager 0.2.40 branch.
- Kept C++-only bundles excluded from the CVI extension.

# Changelog

## 0.6.36

- Updated CVI C communication bundle templates from C/C++ Project Manager 0.2.38.
- Added Doxygen file headers, function comments and usage examples to generated C bundle headers and implementations.
- Preserved the CVI-compatible bundle selection workflow and did not import C++-only bundles.

## 0.6.23

- Treat transient `DMLERR_BUSY` and unavailable DDE responses as silent polling states while CVI is starting and loading the requested workspace.
- Replace the empty persistent-session log row with an explicit `Persistent DDE session handshake accepted` message.
- Enforce the `cmdsrvr.h` action-response contract: only status `0` is accepted for action commands; every non-zero value is surfaced as a rejection.
- Decode unexpected positive status values conservatively by showing the matching CVI command-error description when one exists, without advancing the cached execution state.
- Make **CVI Debug** action rows contextual: unavailable controls remain visible but are dimmed and non-clickable.
- Preserve `Continue` and `Stop` availability throughout an active persistent session so breakpoints that suspend CVI asynchronously remain controllable even when the local state is cached.

## 0.6.22

- Adds a native resizable **CVI Debug** view below **CVI Actions**.
- Displays native bridge availability, persistent DDE-session state, cached execution state, active project, link state, selected transport, state source, last transmitted command and last result.
- Adds direct **Build**, **Run**, **Pause**, **Continue**, **Stop**, **Refresh native state** and **Diagnose native bridge** actions inside the new view.
- Replaces the static native-debug status-bar icon with a live indicator: `CVI:off`, `CVI:idle`, `CVI:run` or `CVI:pause`.
- Publishes native-command state transitions through a VS Code event so the view and status bar update immediately after persistent-session commands.

# Changelog

## 0.6.24

- Add an inline VS Code Debug Adapter Protocol bridge under the `labwindows-cvi-native` debug type.
- Add **LabWindows/CVI: Start Debugging in VS Code** and expose it as the primary action in the `CVI Debug` view.
- Keep the native CVI IDE as the backend engine but launch it minimized by default for VS Code-controlled sessions.
- Route VS Code debug toolbar actions `Pause`, `Continue`, and `Stop` through the validated persistent DDE conversation.
- Advertise standard source breakpoints to VS Code and keep the existing conservative `.cws` synchronization before native launch.
- Add non-destructive polling over the persistent DDE session to detect asynchronous native breakpoint suspensions when CVI accepts state queries during execution.
- Keep polling failures non-fatal: the persistent control session remains usable even if native CVI temporarily refuses `Get CVI State`.
- Add `labwindowsCvi.nativeDebuggerIdeWindowMode`, `labwindowsCvi.keepNativeIdeMinimizedDuringVsCodeDebug`, `labwindowsCvi.nativeDapPollIntervalMs`, and `labwindowsCvi.nativeDapPollTimeoutMs`.
- Preserve the legacy direct native CVI-window launch as a compatibility fallback.
- Explicitly report the phase-one limitations: native call stack, variable evaluation, and step-over/step-in/step-out are not exposed until a stable CVI automation primitive is identified.

## 0.6.21

- Keep a persistent DDE conversation open before `Run Project` so native debug controls remain available while the CVI user program is executing.
- Route `Suspend Execution`, `Continue Execution`, and `Terminate Execution` through the already-established DDE session instead of opening a new PowerShell process and reconnecting after the run has started.
- Remove synchronous `Get CVI State` probes from active Pause, Continue, and Stop controls because CVI 2020 can stop servicing new DDE conversations while the debugged program is running.
- Track an optimistic cached execution state during the persistent session and expose it in diagnostics without blocking the control channel.
- Close the persistent DDE session when the extension is disposed or the selected workspace changes.
- Add `labwindowsCvi.nativeDdeSessionStartupTimeoutMs` for the initial persistent-session handshake.

## 0.6.20

- Switch the default native CVI command transport back to the validated historical DDE server (`cvi` / `system` / `status`).
- Keep the `CVI.Application` ActiveX bridge as an explicit experimental compatibility mode instead of invoking it automatically.
- Prevent automatic ActiveX COM activation from opening a second empty CVI workspace while the extension is waiting for the requested `.cws` file.
- Poll the DDE server directly after launching CVI with the workspace path, ensuring one deterministic native IDE instance.
- Add state-aware guards for Build, Run, Pause, Continue and Stop so incompatible commands are not sent to CVI.
- Decode CVI ActiveX HRESULT-style values in the `0x800400xx` range back to readable CVI command statuses.
- Add `labwindowsCvi.nativeCommandTransport` (`dde`, `auto`, `activex`) and `labwindowsCvi.allowActiveXAutoStart` (disabled by default).

## 0.6.19

- Promote the officially registered `CVI.Application` ActiveX automation server to the primary native-command transport.
- Detect the active CVI automation object through the Running Object Table first, then create or attach `CVI.Application` only when the command explicitly permits it.
- Map the existing native controls to the ActiveX methods `GetCVIState`, `BuildProject`, `RunProject`, `SuspendExecution`, `ContinueExecution` and `TerminateExecution`.
- Keep the historical ANSI/Unicode DDE implementation only as a compatibility fallback for older CVI installations.
- Add the embedded `native/cvi-activex-command.ps1` script and `labwindowsCvi.nativeActiveXProcessTimeoutMs`.
- Extend the output-channel diagnostic with the ActiveX ProgID, connection mode, invoked method and per-connection attempt details.

## 0.6.18

- Fixed native-command diagnostics that could be killed before returning JSON when Windows PowerShell needed more time to compile the embedded C# DDE helper.
- Split the DDE transaction timeout from the PowerShell host-process timeout. The first invocation now receives a configurable host allowance while the actual CVI command response remains bounded independently.
- Cache the managed DDE helper under `%LOCALAPPDATA%\LabWindowsCviProjectManager\NativeBridge\CviDdeBridge.0.6.18.dll`; later invocations load the cached assembly instead of recompiling inline C# source.
- Replace the slow full CLSID PowerShell-provider traversal with a targeted .NET registry scan of plausible CVI ProgIDs, both 32-bit and 64-bit registry views, plus `cvi.exe` App Paths.
- Add cache-bootstrap details to the `LabWindows/CVI` output channel.
- Add `labwindowsCvi.nativeBridgeProcessTimeoutMs` and `labwindowsCvi.activeXDiscoveryTimeoutMs`.

## 0.6.14

- Added a native CVI breakpoint bridge that serializes standard enabled VS Code source breakpoints into the active `.cws` workspace.
- Added `Synchronize VS Code Breakpoints to Native Workspace`, `Remove Synchronized Breakpoints from Native Workspace`, and `Diagnose Native Breakpoint Bridge`.
- Native CVI breakpoints created manually in LabWindows/CVI are preserved; only breakpoints previously injected by the extension are removed during resynchronization.
- Debug builds now synchronize supported VS Code breakpoints automatically before opening the native CVI debugger.
- Conditional, hit-count, log and disabled VS Code breakpoints are skipped conservatively until their native CVI serialization has been validated.

## 0.6.13

- Fixed project-build settings persistence for projects created or added directly from VS Code.
- Initialize the native `.cws` project blocks immediately when a workspace project reference is added: project header, four default build configurations, build options, execution target, SCC compatibility fields, DLL-debugging support and command-line compatibility fields.
- Initialize CVI 2020+ build-dependency blocks when the workspace format requires them.
- Extend `LabWindows/CVI: Repair Native Workspace Compatibility` so workspaces created with 0.6.12 can be migrated without opening and resaving them in LabWindows/CVI first.
- Auto-initialize missing native project blocks when run settings are saved, while preserving timestamped `.cws` backups.
- Create fully initialized native project blocks for the first project of a newly generated workspace.

## 0.6.12

- Added **Create New Project in Workspace...** to the CVI workspace context menu.
- Kept **Add Existing Project to Workspace** as a separate command for existing `.prj` files.
- The new-project wizard selects a destination directory, project name and target type (`Executable`, `Dynamic Link Library` or `Static Library`).
- Newly created projects are added to the current `.cws` and selected as the active project.
- Native `.cws` backup creation remains active before the workspace reference is updated.

## 0.6.10

- Reordered the DLL options grid for a more coherent visual layout.
- Placed **Custom copy directory** directly opposite **Where to copy DLL**.
- Moved **Import library base name** to the second row opposite **Export mode**.
- Preserved all existing DLL conditional enablement rules and native persistence behavior.

## 0.6.9

- Added CVI-like conditional enablement for DLL target settings.
- Disabled exported-header selection when the export mode is `Symbols Marked As Export`.
- Disabled the import-library base-name field when the default base name is selected.
- Disabled the custom DLL-copy directory unless `Custom directory` is selected.
- Disabled the manifest path and browse button unless `Embed manifest` is enabled.
- Moved IVI and VXIplug&play import-library subdirectory choices behind a dedicated `Import library choices…` dialog matching the native CVI workflow.

## 0.6.8

- Refined the DLL Type Information editor with two CVI-like sub-blocks.
- Added conditional enablement for type-library controls.
- Added HLP / CHM TLB help-file selection.
- Added conditional NI type-information source controls and a header selector shown only for the single-header mode.

## 0.6.7

- Stacked **Target** and **Project dependencies and build order** vertically so their collapsible sections resize consistently.
- Disabled and visually dimmed **LoadExternalModule options** whenever run-time support is set to `Instrument Driver Support Only`, matching CVI behavior.
- Preserved previously selected LoadExternalModule entries while the section is unavailable; no native project data is deleted implicitly.
- Added the same guard to the native safe-mode build-settings editor.


## 0.6.6

- Made the Project Build Settings sections collapsible.
- Replaced the raw LoadExternalModule textarea with CVI-style enable/add/preview/remove controls.
- Added editor-context conversion of selected integer literals to decimal, hexadecimal or binary.
# Change Log

## 0.6.5

- Added `Copy Path` and `Copy Relative Path` to the context menu of every file in the CVI workspace explorer.
- `Copy Relative Path` uses the containing VS Code workspace folder first, then the loaded CVI workspace directory, and finally the CVI project directory as a fallback.
- Clipboard actions are silent, matching the behavior of the native VS Code explorer.

# Changelog

## 0.6.21

- Keep a persistent DDE conversation open before `Run Project` so native debug controls remain available while the CVI user program is executing.
- Route `Suspend Execution`, `Continue Execution`, and `Terminate Execution` through the already-established DDE session instead of opening a new PowerShell process and reconnecting after the run has started.
- Remove synchronous `Get CVI State` probes from active Pause, Continue, and Stop controls because CVI 2020 can stop servicing new DDE conversations while the debugged program is running.
- Track an optimistic cached execution state during the persistent session and expose it in diagnostics without blocking the control channel.
- Close the persistent DDE session when the extension is disposed or the selected workspace changes.
- Add `labwindowsCvi.nativeDdeSessionStartupTimeoutMs` for the initial persistent-session handshake.

## 0.6.4

- Added native folder/file browser buttons beside build-settings path fields.
- Added a configuration scope selector for `Debug`, `Release`, `Debug64`, `Release64` and `All Configurations`.
- Added target-aware drop-down lists for run-time support, run-time engine binding and generated source documentation.
- Added verified DLL drop-down lists for DLL copy destination and export mode.
- Applied `All Configurations` changes through the existing guarded native `.prj` / `.cws` writers and backup mechanism.
- Extended safe mode with the same configuration scope and verified list selectors.

## 0.6.3

- Replaced the auto-loaded CVI Actions WebviewView with a native TreeView summary to avoid triggering Chromium service-worker initialization during extension startup.
- Added `Project Build Settings (Safe Mode)…`, a native Quick Pick/Input Box fallback for environments where VS Code webviews are temporarily unavailable.
- Kept the full HTML project settings editor for normal use.

## 0.6.2

- Add native EXE, DLL and static-library target-settings editing based on CVI-generated reference projects.
- Add version information, signing fields, LoadExternalModule module lists, DLL export options and DLL type-information settings.
- Add a guided header context action for native CVI DLL import-library generation.
- Preserve native backup creation before project-file writes.

# Changelog

## 0.6.21

- Keep a persistent DDE conversation open before `Run Project` so native debug controls remain available while the CVI user program is executing.
- Route `Suspend Execution`, `Continue Execution`, and `Terminate Execution` through the already-established DDE session instead of opening a new PowerShell process and reconnecting after the run has started.
- Remove synchronous `Get CVI State` probes from active Pause, Continue, and Stop controls because CVI 2020 can stop servicing new DDE conversations while the debugged program is running.
- Track an optimistic cached execution state during the persistent session and expose it in diagnostics without blocking the control channel.
- Close the persistent DDE session when the extension is disposed or the selected workspace changes.
- Add `labwindowsCvi.nativeDdeSessionStartupTimeoutMs` for the initial persistent-session handshake.

## 0.6.1

- Prevented native CVI workspace corruption when saving command-line and DLL-debugging settings.
- Persist runtime settings only in `[Default Build Config NNNN <mode>]`; legacy compatibility sections are no longer rewritten.
- Convert Windows absolute runtime paths back to CVI `/c/...` notation before writing `.cws` files.
- Added timestamped `.cws` and `.prj` backups under `.vscode/cvi-native-backups`.
- Added `LabWindows/CVI: Repair Native Workspace Compatibility` for files affected by earlier releases.
- Added compatibility inspection when opening a `.cws` workspace.

# 0.5.9

- Moved the persistent command toolbar from the collapsible CVI Actions webview to the CVI Workspace title bar.
- Removed the duplicated Open Workspace in CVI toolbar icon; the workspace inline action remains available.
- Added direct Build + Run and a Run Options picker with Build + Run, Run without build, and native CVI debug choices.
- Restored compact dynamic toolbar labels for build mode (`D32`, `R32`, `D64`, `R64`) and target type (`EXE`, `DLL`, `LIB`).
- Reordered the sidebar so CVI Workspace appears before the collapsible CVI Actions summary.

# Changelog

## 0.6.21

- Keep a persistent DDE conversation open before `Run Project` so native debug controls remain available while the CVI user program is executing.
- Route `Suspend Execution`, `Continue Execution`, and `Terminate Execution` through the already-established DDE session instead of opening a new PowerShell process and reconnecting after the run has started.
- Remove synchronous `Get CVI State` probes from active Pause, Continue, and Stop controls because CVI 2020 can stop servicing new DDE conversations while the debugged program is running.
- Track an optimistic cached execution state during the persistent session and expose it in diagnostics without blocking the control channel.
- Close the persistent DDE session when the extension is disposed or the selected workspace changes.
- Add `labwindowsCvi.nativeDdeSessionStartupTimeoutMs` for the initial persistent-session handshake.

## 0.5.8

- Normalize CVI/MSYS runtime paths such as `/c/PROG_CVI/EXE/Test.exe` before starting DLL host executables.
- Move the CVI Actions toolbar to persistent `view/title` commands so it remains available when the dashboard is collapsed.
- Add supplemental project and CVI API completion items for C/C++ files.
- Add the `CVI File Symbols` view with click-to-navigate function entries.

# 0.5.6

- Added a persistent compact **CVI Actions** webview at the top of the LabWindows/CVI side-bar container. It exposes Home, open, native-CVI open, build/rebuild/clean, run, debug, build mode, target type, project settings and refresh actions without requiring mouse hover.
- Removed duplicate hover-only workspace toolbar buttons from the **CVI Workspace** view.
- Added native parsing and persistence of CVI project build steps from `.prj` sections such as `[Debug Pre-build Actions]`, `[Debug Custom Build Actions]` and `[Debug Post-build Actions]`.
- Added native parsing and persistence of per-configuration launch arguments, working directory, environment options and external process path from `.cws` sections such as `[Default Build Config 0001 Debug]`.
- Prevented duplicate execution of native CVI build steps: when native `.prj` sections are present, `compile.exe` remains responsible for running them.
- Retained extension-side dependency ordering as a fallback until a CVI workspace containing at least one non-empty native dependency graph is available for exact format validation.

# 0.5.5

- Added a compact **Build / Rebuild / Clean** picker to the project explorer toolbar.
- Added full build-output streaming through `compile.exe -log`, with timestamped logs under `.vscode/cvi-build-logs`.
- Added a workspace context-menu action to open the current `.cws` or standalone `.prj` in the native CVI IDE.
- Added target-type selection for `Executable`, `Dynamic Link Library` and `Static Library` projects.
- Added a project build-settings editor for extension-managed pre-build, custom-build and post-build shell actions.
- Added extension-managed project dependencies and deterministic dependency build order.
- Added command-line arguments, working directory, environment options and DLL host executable settings; supported values are mirrored into the CVI workspace sections when a `.cws` is loaded.
- Added conservative generated-target cleaning without deleting source files or referenced external libraries.
- Added **Generate Prototypes Header...** for C source files. The generator creates an editable `.h` baseline and adds it to the CVI project.
- Moved IntelliSense synchronization, diagnosis and provider-repair actions from the explorer toolbar to the Home installation section.

# 0.5.4

- Restored the larger native VS Code file-type icons used by the early project explorer while retaining an explicit child branch marker in file labels.
- Reworked the home page into vertical sections: workspace and active project, libraries and reusable tools, then CVI installation.
- Added a dedicated empty-project state with primary actions to open a workspace, create a starter workspace and select a CVI installation.
- Clarified the UIR editing boundary: panels are opened directly in the LabWindows/CVI User Interface Editor, which is part of the CVI IDE; CVI does not provide a standalone UIR editor.

# Changelog

## 0.6.21

- Keep a persistent DDE conversation open before `Run Project` so native debug controls remain available while the CVI user program is executing.
- Route `Suspend Execution`, `Continue Execution`, and `Terminate Execution` through the already-established DDE session instead of opening a new PowerShell process and reconnecting after the run has started.
- Remove synchronous `Get CVI State` probes from active Pause, Continue, and Stop controls because CVI 2020 can stop servicing new DDE conversations while the debugged program is running.
- Track an optimistic cached execution state during the persistent session and expose it in diagnostics without blocking the control channel.
- Close the persistent DDE session when the extension is disposed or the selected workspace changes.
- Add `labwindowsCvi.nativeDdeSessionStartupTimeoutMs` for the initial persistent-session handshake.

## 0.5.3

- Disables the dynamic Microsoft C/C++ configuration provider by default. The normal path is now the managed `.vscode/c_cpp_properties.json` file in the CVI folder automatically added to the standard VS Code Explorer.
- Adds `LabWindows/CVI: Repair C/C++ IntelliSense Provider Selection` to remove stale global, workspace and folder-level `C_Cpp.default.configurationProvider` values and clean managed `c_cpp_properties.json` entries.
- Migrates the provider identifier from the historical `jc-tools.labwindows-cvi-project-manager` value to the published Marketplace identifier `JerryCrozet-ElectronicEngineer.labwindows-cvi-project-manager`.
- Detects MSVC compatibility include directories exposing `excpt.h` when the optional provider is enabled.
- Adds the 128 × 128 Marketplace icon.

# Changelog

## 0.6.21

- Keep a persistent DDE conversation open before `Run Project` so native debug controls remain available while the CVI user program is executing.
- Route `Suspend Execution`, `Continue Execution`, and `Terminate Execution` through the already-established DDE session instead of opening a new PowerShell process and reconnecting after the run has started.
- Remove synchronous `Get CVI State` probes from active Pause, Continue, and Stop controls because CVI 2020 can stop servicing new DDE conversations while the debugged program is running.
- Track an optimistic cached execution state during the persistent session and expose it in diagnostics without blocking the control channel.
- Close the persistent DDE session when the extension is disposed or the selected workspace changes.
- Add `labwindowsCvi.nativeDdeSessionStartupTimeoutMs` for the initial persistent-session handshake.

## 0.5.2

- Automatically adds the directory containing an opened CVI workspace or project to the standard VS Code Explorer.
- Adds `labwindowsCvi.autoAddCviFolderToWorkspace` to disable this behavior when a manual multi-root workspace is preferred.
- Extends Windows SDK discovery to Windows Kits 10, Windows Kits 8.1 and the historical Windows v7.1A SDK.
- Adds explicit versioned Windows SDK include directories, including `um`, `shared`, `ucrt`, `winrt` and `cppwinrt`, so `windows.h` is resolved reliably.
- Adds targeted CVI ANSI header discovery and diagnostic output for `ansi.h` / `ansi_c.h`.

## 0.5.1

- Added a dynamic Microsoft C/C++ custom configuration provider for CVI project files.
- Kept managed `.vscode/c_cpp_properties.json` generation as a readable fallback and added `configurationProvider` plus `mergeConfigurations` to the managed entry.
- Added explicit `include`, `include/ansi`, `include/clang/**`, `toolslib`, `toolslib/**` and `toolslib/toolbox` paths.
- Added concrete recursive header-directory enumeration in the dynamic provider to improve `toolbox.h` and nested Toolslib resolution.
- Added project source and header directories to generated and dynamic IntelliSense configurations.
- Extended CVI compiler detection to nested `bin/clang/<version>` directories and to `clang-cc.exe`, `clang.exe` and `clang-cl.exe`.
- Added `labwindowsCvi.intelliSenseCompilerPath` for manual compiler override.
- Added `labwindowsCvi.additionalIncludePaths` for project-specific external headers.
- Added `labwindowsCvi.useCppToolsConfigurationProvider` to disable the dynamic provider when required.
- Added **LabWindows/CVI: Diagnose C/C++ IntelliSense Configuration**.
- Added **LabWindows/CVI: Add CVI Folder to VS Code Workspace for IntelliSense**.

## 0.5.0

- Updated the embedded JC Lib runtime from `0.7.93` to `0.7.96`.
- Updated the bundled LabWindows/CVI Structured API Pack from `1.2.0` to `1.5.0`.
- Added `data/metadata/cvi_callback_event_catalog.json` while retaining the User Interface attribute catalog.
- Consolidated `CVI Patterns & References` into `CVI Basics`.
- Added CVIRTE lifecycle cards, editable callback typedefs, parameterized callback skeletons, grouped event selectors, event-data selectors, recipes, keywords and workflows through the updated CVI pack.
- Replaced the basic new-file prompt with **Create New File or Starter...**.
- Added blank CVI `.uir + .h` generation using embedded CVI 2012 and CVI 2020 binary resources.
- Added a complete CVI UI application starter generating `.c + .uir + .h`.
- Added paired `.c + .h` module generation with include guards.
- Added cleaned `main`, `WinMain`, `RTmain` and DLL starter templates.
- Added a cleaned generic CVI error-management module derived from the supplied legacy files.
- Added persistent user-defined creation templates with placeholder expansion.
- Added insertable built-in and user-defined CVI snippets.
- Added configurable snippet shortcut `Ctrl+Alt+I` / `Cmd+Alt+I`.
- Added editor contextual actions for inserting and saving snippets.
- Added a project-tree contextual action for saving a source or header as a creation template.
- Added `labwindowsCvi.uirTemplateVersion` with `auto`, `cvi2012` and `cvi2020` modes.

## 0.4.2

- Updated the embedded JC Lib engine from 0.7.90 to 0.7.93.
- Updated the bundled LabWindows/CVI Structured API Pack from 1.1.0 to 1.2.0.
- Added `data/metadata/cvi_ui_attribute_catalog.json`.
- Extended structured attribute pickers to the 24 `Set*Attribute` functions from the CVI User Interface API.
- Added contextual value pickers based on the selected `ATTR_*` constant.
- Added safe bundled-pack migration with a timestamped backup of the previous writable CVI pack.

## 0.4.1

- Replaced the Activity Bar IHI-style glyph with a compact CVI glyph.
- Displayed the workspace home action as a Home icon.
- Added configurable Find Symbol shortcut `Ctrl+Alt+P` / `Cmd+Alt+P`.

## 0.4.0

- Added composite branch-and-file-type SVG icons.
- Added the resizable **CVI Libraries** view below **CVI Workspace**.
- Embedded the JC Lib-based CVI function explorer.
- Added **Build Debug and Open Native Debugger**.

## 0.3.0

- Added CVI-like context menus, logical folders, new-file creation, file replacement, include/exclude toggles, `.Obj` toggling and single-file compilation.

## 0.2.0

- Added managed `.vscode/c_cpp_properties.json` generation and CVI IntelliSense paths.

## 0.1.0

- Initial CVI workspace, project, build, run and native panel-opening MVP.

## 0.5.7

- Replaced the empty lower area of the always-visible `CVI Actions` view with a compact active-project dashboard.
- Added live summaries for target type, build mode, command-line options, working directory, environment options, native build steps, project dependencies and missing project files.
- Added explicit empty states for workspaces without an active project and for sessions without a loaded CVI workspace.
- Kept the native VS Code resizable view separator so the dashboard can be collapsed or expanded as needed.

## 0.6.0

- Keep the existing `CVI Workspace` view toolbar and add a compact persistent VS Code status-bar action strip for Home, Open, Build, Build + Run, Run options, build mode and target type. These controls remain available when the sidebar views are collapsed.
- Disable the legacy Microsoft C/C++ custom configuration-provider registration permanently. The extension now relies on its generated `.vscode/c_cpp_properties.json` entry.
- Automatically remove stale LabWindows/CVI provider references from user, workspace, folder and managed `c_cpp_properties.json` settings during activation.
- Scope the supplemental CVI completion provider to files belonging to the loaded CVI workspace. Unrelated C and C++ folders no longer receive CVI completion candidates.
- Add `labwindowsCvi.showPersistentStatusBarActions` to hide the persistent status-bar controls when a minimal layout is preferred.

## 0.6.11

- Dims and disables the signing-certificate controls unless **Sign target** is checked.
- Dims **External executable for DLL debugging** unless the current target is a DLL.
- Hides the **Executable command line** section entirely for static-library targets.
- Adds native `.fp` function-panel browsing from the CVI workspace explorer. Opening a function-panel file lists its embedded functions and prototypes without starting the CVI IDE.
- Routes selected `.fp` functions into the embedded JC Lib details view when a matching card exists, with an extracted prototype-and-parameter fallback when the function is not yet present in the bundled pack.

## 0.6.30

- Restored the proven native DDE debug launch path from 0.6.24.
- Removed the experimental VS Code DAP integration from the shipped extension.
- Added a local `compile.exe` preflight build before native debugger launch. CVI is not opened when compile or link fails.
- Routed the CVI Debug build action to the local `compile.exe` workflow.
- Kept the compact grouped CVI Debug dashboard and exact VS Code breakpoint mirror.
- Added conservative natural-completion detection through independent short-lived DDE probes without modifying the persistent control session.
