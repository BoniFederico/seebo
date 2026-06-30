# IMPL.md — Specifica implementativa di *Seebo.js*

> **Cos'è questo documento.** È la specifica **implementativa** rigorosa di *Seebo*:
> come è fatto il motore dentro. Descrive la pipeline, il lexer, il parser, l'AST, il
> valutatore sospendibile, la macchina a stati, la risoluzione dei requirement, le
> ottimizzazioni opt-in e l'architettura dei pacchetti. Privilegia l'**efficienza** e
> le **garanzie teoriche** (linearità, terminazione, analizzabilità, purezza).
>
> **Documento gemello.** `SPEC.md` definisce il *linguaggio* e l'*API* (il *cosa* e il
> *perché*). Qui si presume nota quella semantica e ci si concentra sul *come*. I
> riferimenti `spec§x.y` rimandano a quel testo.
---

## 1. La pipeline a fasi

```
 documento ──▶ [LEX] ──▶ token ──▶ [PARSE] ──▶ AST
                                          │
                 ┌────────────────────────┼────────────────────────────┐
                 ▼                         ▼                            ▼
            [VALIDATE]                [ANALYZE]                  [RUN] (macchina a stati)
            diagnostica         grafo / piano / capability      Value | Need | Error
                                                                       │
   pre-pass: [EXPAND aggregatori] ──▶ ciclo run/driver ──▶ post-pass: [FINALIZE layout]
```

Proprietà strutturali, da preservare in ogni implementazione:

- **LEX** e **PARSE** sono **puri e sincroni**: il risultato dipende *solo* dal testo
  (e dalla config dei delimitatori) ⇒ **memoizzabili** per hash (§11).
- **VALIDATE** e **ANALYZE** consumano l'AST: **puri, sincroni**.
- **RUN** è il valutatore: anch'esso **puro e sincrono** e **senza I/O**. Non chiama
  capability: si limita a valutare ed **emettere `Need`**.
- **L'asincronia vive solo nel driver** (`drive`/`Seebo`): è lui che interroga le
  capability (eventualmente asincrone) per soddisfare i `Need` tra una `run` e l'altra.
- **EXPAND** (aggregatori) e **FINALIZE** (layout) incorniciano l'esecuzione.

> **Teoria — perché spostare l'I/O fuori dal core.** Tenere `run` puro e sincrono
> massimizza l'analizzabilità e la testabilità (un passo è una funzione
> `State → State` deterministica dato lo stato), rende lo stato **serializzabile** e
> permette di eseguire la stessa logica identica su client e server. L'I/O — l'unica
> fonte di non-determinismo e latenza — è isolato in un orchestratore sottile.

---

## 2. Lexer: una passata, blocchi atomici, O(n)

Il lexer scorre il testo **una sola volta** (complessità **lineare**). Due accorgimenti
chiave:

- **Riconoscimento dei sigilli.** Un nuovo slot inizia solo a `'$' '{'`, `'#' '{'`,
  `'@' '{'` (rispettando l'escape `\`). Fuori dagli slot il testo è copiato verbatim:
  nessuna interpretazione, nessun costo. I sigilli sono presi dalla config
  `delimiters`, non hardcoded.
- **Blocchi atomici saltabili.** Dentro uno slot, all'incontro di una stringa `'…'` o
  di una parentesi `[ … ]` / `( … )`, il lexer **salta l'intero blocco** tracciando la
  profondità, senza analizzarlo carattere-per-carattere al livello superiore. Questo
  mantiene lineare anche la ricerca della `}` di chiusura di primo livello.

**Doppia modalità.** Per `tokenize` (editor) il lexer è **error-tolerant**: davanti a
uno slot incompleto emette i token raccolti finora e prosegue. Per `parse` un input
malformato produce un **errore con posizione**.

**Token.** Ogni token porta `{ kind, start, end }`. `kind` ∈ {`text`, `slot-open`,
`slot-close`, `sigil`, `name`, `method`, `number`, `string`, `bool`, `operator`,
`dot`, `comma`, `paren`, `bracket`, `brace`, `arrow`(`=>`), `star`(`*` di `match`),
`comment-body`, `macro-name`}. Il `kind` `number` distingue interi/decimali in base
alla presenza del separatore decimale; le durate **non** hanno literal dedicato (si
costruiscono col produttore `duration(secondi)`).

---

## 3. Parser: discesa ricorsiva + Pratt per gli infissi

La grammatica ha due "registri":

- la **struttura del documento** (alternanza testo/slot) e le **forme primarie**
  (literal, chiamate `nome(...)`, accessi `.membro`/`.metodo(...)`, `match`, parentesi)
  → **parser a discesa ricorsiva** (*recursive descent*) predittivo: il primo token
  decide la regola. Niente backtracking ⇒ **O(n)**.
- gli **operatori infissi** con precedenze (spec§1.4) → **precedence climbing**
  (equivalente a un *Pratt parser*): a ogni passo si guarda l'operatore e la sua
  precedenza, costruendo l'albero corretto. Anch'esso lineare.

**Tabella di precedenze (autorità implementativa).** Il Pratt parser è guidato da
questa tabella; deve coincidere con spec§1.4:

```
livello  operatori        assoc   binding
  1      . (member/call)  left    postfix
  2      not  -(unario)   right   prefix     // -x ammesso su int|float|duration
  3      *  /             left    560
  4      +  -             left    540
  5      <  <=  >  >=     left    520
  6      ==  !=  in       left    500
  7      and              left    480
  8      or               left    460
  9      ??               right   440
 10      ?:  (ternario)   right   420
```

> **Teoria — perché LL/predittivo.** Una grammatica **LL(1)** è decidibile guardando
> *un solo* token avanti. I delimitatori (`{ } [ ] ( ) '…'`) e i separatori scelti
> rendono la grammatica di Seebo (quasi interamente) LL(1); gli unici punti "infissi"
> sono gestiti dal Pratt parser, la tecnica standard per aggiungere precedenze a un
> recursive descent mantenendo la linearità.

**`match`.** Si analizza come forma primaria: `primary 'match' '{' (arm ',')* '}'`, con
`arm = (expr | '*') '=>' expr`. Si **desugar-izza** subito in una catena di ternari
annidati, così i passi a valle (validate/analyze/run) non conoscono `match` come nodo
speciale. Il default `*` diventa l'ultimo `else`; se assente e i casi non sono
esaustivi, `validate` segnala `NON_EXHAUSTIVE_MATCH`.

**Produttori, capability e desugaring.** Una chiamata `nome(...)` è risolta per nome
contro l'insieme — fissato a `createEngine`, quindi **statico** — dei nomi invocabili:
produttori builtin, funzioni custom (`defineFunction` senza receiver), namespace di
libreria e **capability registrate**. Se `nome` è una capability, il nodo `Call` è
**normalizzato** in un `require` con `capability = nome` (lo zucchero di spec§1.6),
così validate/analyze/run vedono *solo* `require` e non conoscono casi speciali. Essendo
l'insieme dei nomi statico, la normalizzazione non intacca l'analizzabilità.

**Parole riservate e unicità (enforcement).** Alla costruzione del motore, ogni nome
introdotto (tipo/funzione/macro/libreria/capability) è verificato contro la **lista di
parole riservate** (spec§1.5) e contro i nomi già registrati nel medesimo spazio dei
nomi; un conflitto o l'uso di una parola riservata fa **fallire `createEngine`** con un
errore strutturato. La lista è codificata come insieme costante nel core; la verifica è
O(1) per nome.

### 3.1 AST tipizzato e versionato

L'**AST è il contratto pubblico** tra parser e {validate, analyze, run} e tra backend
e frontend. Porta un campo `astVersion`. Ogni nodo porta la propria `position`. Forme
di nodo principali:

```
Document = { astVersion, nodes: Node[] }
Node     = Text { value }
         | Formula { expr: Expr }
         | Comment { }                         // rimosso in fase di emissione
         | Macro { name, args, family }        // family: 'aggregator' | 'layout'
Expr     = Lit { type, value }
         | Ref { name }                        // riferimento a bind/needment dichiarato
         | Call { callee, args }               // produttore  nome(...)
         | Method { receiver, name, args }     // trasformatore  x.nome(...)
         | Member { receiver, key }            // o.campo
         | Unary { op, arg } | Binary { op, left, right }
         | Ternary { cond, then, else }
         | Namespace { ns, name, args }        // fake.email() ecc.
```

---

## 4. Sistema di tipi a runtime

Ogni valore è un record immutabile `{ type, value, format, constraints }`. Il
valutatore:

- applica le **regole di tipo** degli operatori (spec§1.4); un mismatch su tipi noti
  staticamente è già segnalato da `validate`, gli altri sollevano errore in `run`;
- applica i **constraints** quando un valore concreto è disponibile;
- **stringhizza solo all'emissione** dello slot, usando `format` e `locale`.

### 4.1 Rappresentazione canonica dei tipi temporali

- **`datetime`**: istante assoluto. Rappresentazione canonica interna: **epoch in
  millisecondi UTC** + una `precision` (granularità significativa). Tutte le operazioni
  lavorano in UTC; il `locale`/`pattern` interviene solo alla stringhizzazione.
- **`duration`**: span con segno. Rappresentazione canonica interna: **numero di
  secondi** (un `number`, eventualmente frazionario per via di `*`/`/`), coerente con
  la precisione minima `'second'` di `datetime`. Le unità ammesse hanno fattori di
  conversione **costanti**:

```
second = 1
minute = 60
hour   = 3600
day    = 86400
week   = 604800
// mesi e anni: NON rappresentabili (spec§1.3) → il sistema di tipi non li conosce
```

### 4.2 Implementazione dell'aritmetica temporale

Tutte queste operazioni sono **pure** e si riducono ad aritmetica sui canonici:

```
datetime(a) - datetime(b)   → duration( (a.ms - b.ms) / 1000 )           // secondi, con segno
datetime(a) + duration(d)   → datetime( a.ms + d.sec*1000 )
datetime(a) - duration(d)   → datetime( a.ms - d.sec*1000 )
duration(d) + datetime(a)   → datetime( a.ms + d.sec*1000 )              // '+' commutativo
duration(x) + duration(y)   → duration( x.sec + y.sec )
duration(x) - duration(y)   → duration( x.sec - y.sec )
duration(x) * k             → duration( x.sec * k )      (k: int|float)
duration(x) / k             → duration( x.sec / k )      (k: int|float; k=0 ⇒ errore)
duration(x) / duration(y)   → float( x.sec / y.sec )     (y=0 ⇒ errore)
-duration(x)                → duration( -x.sec )
```

Sono **errori di tipo espliciti**: `datetime + datetime`, e qualunque combinazione che
mescoli un `int` con un tipo temporale (`datetime ± int`, `duration ± int`,
`int ± duration`). Gli `int` non si convertono mai implicitamente in durate: il
chiamante deve scrivere `duration(n)` (spec§1.4).

**Precisione del risultato (ordine totale esplicito).** Le precisioni formano una scala
ordinata dalla più grossolana alla più fine:

```
year (0) < month (1) < day (2) < hour (3) < minute (4) < second (5)
```

Quando un'operazione combina due `datetime`, la precisione del risultato è quella di
**rango maggiore** (la più fine: `max` sull'indice 0..5) tra gli operandi — non si perde
granularità. Per evitare ambiguità, nel codice si usa l'indice numerico, non i nomi:
"minimo/massimo" sono fuorvianti senza l'ordine, qui fissato una volta per tutte e
coerente con spec§1.3.

### 4.3 Metodi di `duration`

- **Totali** (`totalSeconds/Minutes/Hours/Days/Weeks`) → `float`: `x.sec / fattore`.
- **Componenti** (`weeks/days/hours/minutes/seconds`) → `int`: scomposizione "da
  orologio" sul valore assoluto, con il **segno applicato solo al componente più
  alto** presente. Algoritmo: `r = |x.sec|`; `weeks = ⌊r/604800⌋`, `r %= 604800`;
  `days = ⌊r/86400⌋`, `r %= 86400`; … fino ai secondi.
- `abs/neg/isNegative` → banali sul canonico.
- `round(unit)/truncate(unit)` → arrotonda/tronca `x.sec` al multiplo del fattore di
  `unit`.

### 4.4 Stringhizzazione di `duration`

Guidata da `format.pattern` (spec§1.3), **non** da uno stile predefinito. Dopo aver
troncato a `constraints.precision`:

1. si individua nel pattern il **token più a sinistra** (l'unità più grande presente):
   quel token riceve il **totale** in quell'unità — `⌊|x.sec| / fattore⌋` — assorbendo
   tutto l'overflow delle unità superiori;
2. i token successivi sono **componenti modulari** entro il proprio modulo (ore 0–23,
   minuti 0–59, …), zero-padded se il token è doppio (`HH`, `mm`, `ss`);
3. il segno negativo, se presente, precede l'intero output.

Token riconosciuti: `W` settimane, `D` giorni, `H`/`HH` ore, `m`/`mm` minuti,
`s`/`ss` secondi; gli altri caratteri del pattern sono letterali. Esempi su una durata
di 50 ore: `'HH:mm:ss'` → `'50:00:00'`; `'D HH:mm:ss'` → `'2 02:00:00'`.

> **Perché tipi fino alla fine.** Conservare il tipo evita conversioni ripetute
> (parse/format di date e numeri) e rende corretti gli operatori (confrontare due
> `datetime`, sommare due `duration` — non due stringhe). È più lavoro implementativo
> (un piccolo *sistema di tipi*), ma elimina un'intera classe di bug di formattazione.

---

## 5. Il valutatore sospendibile: `Value | Need | Error`

Il valutatore è una funzione **pura** che, dato un nodo `Expr` e un **ambiente di
risoluzione** (i requirement già soddisfatti nello stato), restituisce **uno di tre
esiti**:

```
EvalResult = Ok(Value) | Susp(Need) | Err(Diagnostic)
```

Regole di propagazione (semantica di "monade a tre vie"):

- **Purezza.** La valutazione non muta stato. `.format()/.constraints()` ritornano
  nuovi oggetti. Le dichiarazioni `bind/need` non sono effetti: sono raccolte
  staticamente (§8).
- **Propagazione di `Err`.** Un `Err` in una sottoespressione si propaga verso l'alto,
  *salvo* i rami non valutati per lazy (sotto).
- **Propagazione di `Susp` (la novità).** Un `Need` in una sottoespressione **non
  fallisce** il nodo: si propaga come `Susp`. Un operatore con un operando `Susp`
  diventa esso stesso `Susp` (a meno che la lazy lo renda irrilevante). Più `Need`
  raccolti nella stessa passata si **uniscono** in un insieme (`pending`), così il
  driver può soddisfarli in *batch*.
- **Lazy / corto-circuito.** `and/or/??/?:`/`match` valutano **solo i rami
  necessari**. Conseguenza importante: un `Need` in un ramo **non preso** *non viene
  emesso*. Questo è ciò che realizza le **fasi**: i requirement gated da una condizione
  ancora indecisa (perché dipende da un `Need`) non compaiono finché la condizione non
  è risolta.

**Risoluzione di un requirement non soddisfatto.** Quando il valutatore incontra un
`require` il cui `id` non è in `resolved`, applica la precedenza di spec§1.7: (1) se il
`type` porta un `default`, emette `Ok(default)`; (2) altrimenti, se `optional`, emette
`Ok(<vuoto del tipo>)`; (3) altrimenti emette `Susp(Need)`. La nozione di «vuoto»
(`''`, `[]`, `{}` — non `0`/`false`/durata-zero) è quella di spec§1.4.

**Emissione dello slot.** Un `Formula` il cui `Expr` valuta a `Ok(value)` viene
**stringhizzato** (§4) e sostituito nel documento. Se valuta a `Susp`, lo slot resta un
"buco" in attesa (la passata complessiva sarà `waiting`). Se `Err`, il documento è
`failed` (o lo slot è segnalato, secondo `limits`/policy di error-recovery).

---

## 6. La macchina a stati: `run(state) → state`

L'esecuzione è la chiusura del valutatore in una **funzione di transizione pura**.

### 6.1 Forma dello stato: pubblico vs runtime

Si distinguono **due** strutture, deliberatamente separate.

**`PublicState`** — il contratto serializzabile di spec§2.4. È *l'unica* forma che
esce dal motore e si persiste:

```ts
type PublicState = {
  stateVersion: number;
  template: string;                   // SORGENTE del template: canonico e portabile
  resolved: Record<string, Value>;    // requirement soddisfatti, per id
  pending:  RequirementDescriptor[];  // Need dell'ultima passata
  phase:    number;
  status:   'running' | 'waiting' | 'completed' | 'failed';
  output?:  string;
  diagnostics?: Diagnostic[];
};
```

**`RuntimeState`** — una struttura **interna** che il motore costruisce a partire dal
`PublicState` per una singola chiamata `run`, e che **non** viene serializzata:

```ts
type RuntimeState = {
  pub:      PublicState;              // lo stato pubblico di partenza
  astRef:   Hash;                     // chiave dell'AST memoizzato (§11), derivata da `template`
  ast:      Document;                 // l'AST risolto (da cache o riparse)
  // eventuali campi di ottimizzazione (memo intra-passata, checkpoint…) vivono qui
};
```

Regole:

- `run` riceve e restituisce **`PublicState`**; internamente apre un `RuntimeState`
  (idratazione: `astRef = hash(template)`, `ast = cache.get(astRef) ?? parse(template)`)
  e lo scarta a fine passata.
- `astRef`/`ast` sono **ricostruibili in O(parse)** dal solo `template`: non aggiungono
  informazione, sono pura cache ⇒ giustamente fuori dal contratto serializzato.
- Il `PublicState` è un **POJO serializzabile** (JSON / MessagePack): nessuna chiusura,
  nessuna risorsa viva ⇒ salvabile in Redis/DB/file/sessione e ripristinabile altrove,
  anche in un altro processo o un'altra release del motore (compatibilità: §15).

### 6.2 La transizione

`run(pub)` (riceve e restituisce un `PublicState`, §6.1):

1. **idrata** il `RuntimeState`: `astRef = hash(pub.template)`,
   `ast = cache.get(astRef) ?? parse(pub.template)`;
2. valuta il documento col valutatore (§5) usando `pub.resolved` come ambiente;
3. raccoglie l'insieme dei `Need` emersi (solo quelli *attivi*, per via della lazy);
4. calcola il nuovo stato:
   - `pending = Need raccolti`;
   - `phase += 1`;
   - se `pending` vuoto e nessun `Err` ⇒ `status:'completed'`, `output = testo emesso`;
   - se `pending` non vuoto ⇒ `status:'waiting'`;
   - se `Err` fatale ⇒ `status:'failed'`, `diagnostics`.

`run` **non** chiama capability e **non** fa I/O: è `(State) → State`, sincrona e pura.

### 6.3 Il ciclo (reducer) e la sua terminazione

```
while (state.status === 'waiting') {
  const satisfied = soddisfa(state.pending);                  // host: §7
  state = run({ ...state, resolved: { ...state.resolved, ...satisfied } });
}
```

> **Teoria — punto fisso e terminazione.** L'insieme dei requirement *attivi* cresce in
> modo **monotòno** (un requirement attivato da una condizione resa vera non si
> disattiva nello stesso ciclo) e l'universo dei requirement dichiarati è **finito** ⇒
> il processo raggiunge un **punto fisso** in un numero finito di passi. Un ciclo nel
> requirement graph (A attiva B e B attiva A) verrebbe rilevato staticamente (§9) o
> capato da `limits.maxPhases`, emettendo errore invece di iterare all'infinito.

### 6.4 Strategie di ripresa (trasparenti al chiamante)

La forma `run(state) → newState` è **neutrale** rispetto a *come* si riprende. Sono
ammesse, dietro la stessa firma, implementazioni di efficienza crescente:

1. **Re-evaluation completa** (default, più semplice): a ogni `run` si rivaluta l'intero
   AST. Con la memoization intra-passata (§5) e la cache di parse (§11) il costo è
   accettabile per documenti di taglia tipica.
2. **Re-evaluation selettiva**: si rivalutano solo i nodi i cui ingressi sono cambiati
   (i requirement appena soddisfatti) e i rami che ne dipendono, tenendo memoizzati gli
   altri sotto-risultati nello stato.
3. **Checkpoint / continuation**: si serializza un "punto di ripresa" (quali nodi erano
   sospesi) e si riprende esattamente da lì.

Tutte e tre rispettano la stessa semantica osservabile; la scelta è una *strategia
implementativa* (vedi anche le ottimizzazioni §12), non un cambio di modello.

> **La continuation NON è obbligatoria.** Una prima implementazione **conforme** deve
> usare la **strategia 1 (re-evaluation completa)**: è la più semplice ed è già
> corretta, perché il valutatore è puro e idempotente sugli stessi `resolved`. Il
> linguaggio del modello — "il template è *sospeso e ripreso*" — descrive la *semantica*
> osservabile, **non** impone di implementare coroutine, checkpoint o ripresa dal nodo
> sospeso. Le strategie 2 e 3 sono ottimizzazioni che si possono aggiungere dopo, dietro
> profilazione, senza toccare l'API né la teoria. Chi implementa la v1 può ignorarle.

---

## 7. Requirement, capability e driver asincrono

`run` emette `Need`; **il driver li soddisfa**. È l'unico componente asincrono.

### 7.1 Risoluzione di un `Need`

Ogni `RequirementDescriptor` porta una `capability`. Il driver instrada il Need verso
il **Capability Provider** registrato in `createEngine.capabilities[capability]`
(nessuna capability è builtin: l'intero set è dichiarato dall'app, spec§1.6/§2.2):

```
need.capability → engine.capabilities[need.capability](need)  // sync o Promise
```

**Esito di un provider (semantica normativa).** Il valore (eventualmente atteso da una
Promise, o l'eccezione/il timeout) è classificato dal driver in **quattro** esiti, che
ne determinano l'azione:

| Esito | Quando | Azione del driver |
|---|---|---|
| **`Resolved(value)`** | il provider ritorna un valore **non** `undefined` e di tipo valido | inserisce `value` in `resolved`; al prossimo `run` il Need sparisce |
| **`Unresolved`** | il provider ritorna `undefined` (o un sentinella esplicito) | **lascia il Need in `pending`**: nessuno l'ha soddisfatto in questo giro (es. `user` interattiva → si delega al chiamante con `stopOn`) |
| **`ProviderError`** | il provider **lancia**, rifiuta la Promise, o **supera il timeout** (`limits.timeoutMs`) | a seconda della `policy`: `fail` (→ `status:'failed'` con diagnostica `CAPABILITY_ERROR`), oppure `retry` fino a un massimo, oppure `delegate` (degrada a `Unresolved` e lascia il Need) |
| **`InvalidValue`** | il provider ritorna un valore che **viola il `type`/`constraints`** del requirement | diagnostica `CAPABILITY_INVALID_VALUE`; trattato come `ProviderError` ai fini della policy (il dato non entra mai in `resolved` non validato) |

> **Perché distinguerli.** `undefined` *non* è un errore: è il modo legittimo per dire
> "non rispondo io" (capability interattive, cache miss). Errore del provider, valore
> invalido e mancata risposta hanno conseguenze diverse — fallire, ritentare, o
> rimandare all'utente — e tenerli distinti evita che un `undefined` venga scambiato per
> un guasto o che un valore malformato entri nello stato. La validazione del valore
> ritornato (`InvalidValue`) è **sempre** applicata: una capability non può iniettare un
> dato che il sistema di tipi rifiuterebbe.

- le capability che richiedono interazione esterna (es. `user`) restituiscono
  tipicamente `Unresolved`: il driver le lascia in `pending` e ritorna al chiamante
  (`stopOn: ['user']`), che le raccoglie;
- le capability "dato" (es. `crm`, `secrets`, `weather`) si soddisfano dentro il
  driver, spesso **in batch**.

### 7.2 Batching e memoization

Poiché `analyze` (§9) conosce *staticamente* quali capability servono, il driver può
**pre-caricare** in un'unica passata (*resolution bundle*) ed evitare N round-trip: la
differenza tra O(N) chiamate e O(1). Entro una singola conversazione, lo stesso
requirement (stesso `id`) è risolto una sola volta e riusato (memoization su
`resolved`).

### 7.3 `drive`, `expand`, `finalize`, `Seebo`

```
expand(template, templates) → composed     // pre-pass aggregatori (§10) sui template forniti
drive(stateOrTemplate, {stopOn}) → State    // chiude il ciclo §6.3 via capability, async
finalize(text) → text                        // post-pass layout (§10.2), sync e puro
Seebo({template, templates, values}) → State // orchestratore: expand → drive → finalize
```

`values` sono i valori iniziali per i requirement (chiave = `id`), tipicamente quelli
raccolti per le capability interattive. `expand` è dichiarata asincrona per consentire
sorgenti di template asincrone; quando i `templates` sono tutti forniti in memoria si
comporta come una funzione sincrona.

---

## 8. Dichiarazioni statiche e tabella dei simboli

Prima di validare/analizzare/eseguire, una **passata statica** sull'AST raccoglie tutte
le dichiarazioni `bind/need` (anche nei template inclusi via `ABSORB/MERGE`, §10) in
una **tabella dei simboli**: `id → descrittore` (tipo, capability, label, vincoli,
default, opzionalità, e *condizionalità* — sotto quali rami compare).

La tabella:

- consente a `validate` di segnalare gli **identificatori non dichiarati** e le
  **capability non registrate**;
- consente ad `analyze` di emettere i **metadati del form** e il grafo;
- realizza lo **scope statico** di spec§1.7 (un nome è visibile ovunque, a prescindere
  dal ramo).

La raccolta è **puramente sintattica** ⇒ **lineare** e indipendente dai dati.

---

## 9. `analyze` come compilatore: grafo, piano, metriche

`analyze` consuma l'AST + la tabella dei simboli e produce la struttura `Analysis`
(spec§2.3). Come si calcola ciascun campo:

- **`requirements`**: la tabella dei simboli, filtrata sui requirement (esclusi i
  value-binding puri), **arricchita** con i campi derivati `phase` e `options` (quest'ultimo
  estratto da `type.constraints.values`).
- **`requirementGraph`**: per ogni requirement `B` dichiarato *dentro* un ramo
  condizionale, si calcolano i requirement `A` referenziati dalla **condizione** che
  governa quel ramo; si aggiunge l'arco `A → B`. Distinzione netta da una semplice
  dipendenza di dato (spec§1.6): l'arco esiste solo se `A` **abilita** `B`.
- **`executionPlan` / `phases`**: ordinamento topologico del requirement graph. La
  **fase** di un requirement è la lunghezza del cammino più lungo dalle radici fino ad
  esso (i requirement incondizionati sono in fase 1). Un ciclo ⇒ `potentialCycles`.
- **`capabilitiesUsed`**: insieme delle `capability` distinte nei requirement.
- **`staticValues`**: sottoinsieme di slot risolvibili **a freddo** — espressioni
  totalmente pure (literal, `now`/`fake` solo se `clock`/`seed` sono fissati e
  deterministici) senza requirement. Si valutano subito col valutatore (§5): se danno
  `Ok`, finiscono qui.
- **`deterministic`**: `true` sse l'AST non usa produttori non deterministici *liberi*
  (`now`/`fake` senza `clock`/`seed` fissati).
- **`streamability`**: analisi statica dell'idoneità all'output incrementale (per
  `stream`, §12.2). Si scandisce l'AST in ordine di emissione e si classifica:
  - **`full`** — nessuna macro di layout che riscrive testo *già emesso* e nessun nodo
    che possa riordinare l'output: ogni prefisso è definitivo appena prodotto.
  - **`partial`** — esistono **punti sicuri** oltre i quali serve il buffering. Un punto
    sicuro è un offset `p` tale che nessun nodo a destra di `p` può modificare testo a
    sinistra di `p` (nessuna `COLLAPSE`/`REMOVE_LINE`/`REMOVE_LEFT` il cui raggio
    attraversi `p`, nessun `Need` a sinistra ancora aperto). Si emette fino a `p`, poi
    si bufferizza il segmento successivo.
  - **`buffered`** — il primo punto sicuro è la fine del documento (macro che agiscono
    all'indietro su ampio raggio, o riordino globale).
  Quando il risultato non è `full`, si allegano diagnostiche (severità *info*) che
  indicano i nodi responsabili. Il criterio dei "punti sicuri" è **normativo**: due
  implementazioni conformi devono concordare sulla classificazione.
- **`potentialCycles`**: cicli rilevati nell'espansione (§10) e nel requirement graph.
- **`maxPhases`**: profondità del requirement graph (capata da `limits.maxPhases`).
- **`worstCaseRequirements`**: numero di requirement sul cammino più costoso (somma dei
  requirement attivabili nel ramo peggiore).

Tutto questo è **statico e puro**: nessun dato reale, nessuna capability interrogata.

---

## 10. Aggregatori e macro di layout

### 10.1 EXPAND (pre-pass): aggregatori, anti-ciclo, limiti

`ABSORB/MERGE` sono espansi **prima** della risoluzione delle formule:

- l'espansione è **ricorsiva** (un template incluso può includere) ma **limitata**: si
  tiene una *catena di inclusione* per rilevare i **cicli** e un contatore di
  **profondità** (`limits.maxDepth`);
- `MERGE` seleziona i template per **pattern**: per sicurezza/perf si usa un **glob**
  ancorato o un motore regex *linear-time* (RE2-like) con **timeout** — mai backtracking
  (rischio **ReDoS**, pericoloso lato client);
- l'espansione produce un documento "piatto" su cui poi gira l'esecuzione; i requirement
  importati confluiscono naturalmente nella tabella dei simboli (§8).

### 10.2 FINALIZE (post-pass): layout/rimozione, posizionale

`REMOVE_LINE/COLLAPSE/REMOVE_LEFT/REMOVE_RIGHT` operano **dopo** la risoluzione, sul
testo emesso. Sono **posizionali**: ogni marcatore conosce la propria posizione e
rimuove sé stesso e l'intorno indicato. Si applicano in un'unica passata stabile
sull'output, in ordine di posizione, ricalcolando gli offset man mano.

---

## 11. Caching e incrementalità

- **Parse/analyze cache.** `tokenize`, `parse`, `analyze`, `validate` dipendono *solo*
  dal testo (+ config) ⇒ si memoizzano per **hash del template** (l'`astRef` del
  `RuntimeState`, §6.1, è proprio questa chiave). In un editor, dove il testo cambia
  poco a ogni tasto, questo abbatte il costo; in prospettiva abilita l'*incremental
  parsing*.
- **Resolution bundle.** Vedi §7.2: un'unica fetch dei dati richiesti.
- **Esecuzione incrementale.** Tra una fase e l'altra cambia solo un sottoinsieme di
  requirement: si possono ri-valutare **solo** le condizioni/sezioni impattate (§6.4,
  strategia 2).

---

## 12. Ottimizzazioni opt-in (`createEngine.optimizations`)

Queste ottimizzazioni **non cambiano la semantica osservabile**; si **abilitano
esplicitamente** in `createEngine` perché ciascuna comporta un costo (complessità,
memoria, vincoli). Default: **tutte disattivate**. Valutazione critica per ognuna.

### 12.1 `astCache` — serializzazione binaria dell'AST  *(consigliata)*

- **Cosa.** Serializza l'AST parsato in formato binario (MessagePack o FlatBuffers) e lo
  ricarica saltando del tutto la fase di parse.
- **Come.** Chiave = hash del contenuto del template; store = `localStorage`/IndexedDB
  (client) o disco/Redis (server). È l'estensione persistente della cache §11.
- **Quando conviene.** Template stabili riusati molte volte (render server-side,
  generazione bulk).
- **Trade-off.** Costo di serializzazione iniziale; **invalidazione**: la chiave deve
  includere `astVersion` *e* l'hash della config dei delimitatori, altrimenti si
  ricarica un AST incompatibile. **Bassa complessità**, alto rendimento ⇒ raccomandata.

### 12.2 `stream` — output in streaming  *(utile, con vincoli)*

- **Cosa.** `Seebo` può restituire un `AsyncIterable<string>` che emette i chunk
  risolti man mano, senza bufferizzare l'intero output.

```js
for await (const chunk of engine.SeeboStream({ template, values })) response.write(chunk);
```

- **Quando conviene.** Documenti grandi (contratti, report) dove il memory footprint
  deve restare costante.
- **Vincoli.** Compatibile **solo** con template a **output linearmente ordinato**: si
  può emettere un prefisso solo quando è definitivo. La decisione **non** è euristica a
  runtime: è guidata dal campo `streamability` calcolato da `analyze` (§9), che è
  normativo. Se `full` → emissione piena; se `partial` → si emette fino a ogni **punto
  sicuro** e si bufferizza tra l'uno e l'altro; se `buffered` → si bufferizza l'intero
  output (lo "streaming" coincide col caso non-streaming). Le macro di layout che
  riscrivono testo già emesso (`COLLAPSE`, `REMOVE_LINE` su righe precedenti) e i `Need`
  aperti a monte sono esattamente ciò che abbassa la classe. **Complessità media.**

### 12.3 `lazyParse` — costruzione pigra dell'AST  *(di nicchia)*

- **Cosa.** Non costruire interamente l'AST dei rami condizionali che la valutazione
  non raggiunge; deferire il parsing delle sotto-espressioni finché non servono.
- **Limite intrinseco.** `analyze` e `validate` **richiedono comunque l'intero AST**
  (devono vedere *tutti* i requirement, anche nei rami non presi): l'ottimizzazione si
  applica **solo** al cammino `run`/`Seebo`, non all'analisi.
- **Valutazione critica.** Con la cache di parse (§11/§12.1) il parse avviene **una
  volta sola**; rifarlo pigramente raramente ripaga, e complica error-tolerance e
  posizioni. **Sconsigliata** salvo profili che dimostrino il parse come collo di
  bottiglia su template enormi e fortemente ramificati. **Off di default.**

### 12.4 `objectPool` — pooling dei nodi AST  *(micro-ottimizzazione)*

- **Cosa.** Riusare gli oggetti-nodo da un pool pre-allocato per ridurre la pressione
  sul garbage collector in cicli ripetuti parse→evaluate (es. live preview).
- **Trade-off.** Richiede **disciplina di lifecycle** (restituire i nodi al pool senza
  trattenere riferimenti vivi): un nodo riusato per errore mentre è ancora referenziato
  introduce bug subdoli. In contrasto con l'immutabilità che altrove diamo per scontata.
- **Valutazione critica.** Beneficio reale solo in *hot loop* misurati; rischio/peso non
  trascurabile. **Off di default**, da abilitare solo dietro profilazione.

> **Principio guida.** Le ottimizzazioni che **non** intaccano l'immutabilità e
> l'analizzabilità (`astCache`, `stream`) sono di prima scelta; quelle che vi
> confliggono (`lazyParse`, `objectPool`) restano opzioni di nicchia, esplicite e
> reversibili.

---

## 13. Determinismo, sicurezza, isomorfismo

- **Determinismo iniettabile.** `clock` e `seed` nel contesto rendono riproducibili
  `now`/`fake`/random — fondamentale perché **anteprima** (frontend) e **output
  autorevole** (backend) possano coincidere quando serve. `analyze.deterministic`
  segnala se un template è riproducibile.
- **Limiti.** `maxDepth`, `maxPhases`, `maxOutputBytes`, `timeoutMs` ⇒ garanzia di
  terminazione e protezione da template malevoli (specie lato client).
- **Confine di fiducia.** Il frontend esegue il motore per la UX; il backend resta
  l'**autorità** che ri-esegue e ri-valida gli output definitivi. Poiché `run` è puro e
  lo `State` è serializzabile, una conversazione iniziata sul client può essere
  **conclusa e verificata** sul server con lo stesso codice.
- **Autorizzazione e governo delle capability (`policy`).** Le capability sono il punto
  in cui il motore tocca dati sensibili (segreti, ERP), quindi il loro uso è governato
  dalla `policy` (spec§2.2). L'implementazione applica, **prima** di invocare un
  provider:
  - **allow-list**: se la capability non è in `policy.allowedCapabilities` →
    `CAPABILITY_FORBIDDEN`, senza chiamare il provider.
  - **regole per-capability** (`policy.capabilityRules`): `allowFrom` confronta il
    `policy.trustLevel` del template con il livello richiesto (es. `secrets` solo da
    template `trusted`); `audit: true` registra un evento di audit per ogni invocazione
    (chi, quale requirement, esito) **senza** il valore in chiaro.
  - **masking/redazione** (`policy.redact`): i valori delle capability elencate sono
    **mascherati** in log, audit e in ogni `diagnostics` (anche `InvalidValue` non deve
    mai stampare il segreto). Il masking è applicato alla *sorgente* (al confine del
    provider), non come post-processing fragile.
  - **timeout e limiti**: ogni invocazione è soggetta a `limits.timeoutMs` (§7.1,
    `ProviderError`), così un provider lento o bloccato non compromette la terminazione.
- **Isomorfismo.** Il core non usa API esclusive di un ambiente. Le dipendenze pesanti o
  node-only (`faker`, `crypto` per gli hash) sono **librerie/capability opzionali**
  caricate pigramente (`defineLibrary`/`defineCapability`), così il core resta piccolo,
  *tree-shakeable* e identico su browser e server.

## 14. Versionamento e policy di compatibilità

Tre contratti attraversano il confine motore↔applicazione e portano un numero di
versione **indipendente**:

| Versione | Su cosa | Cresce quando |
|---|---|---|
| `astVersion` | forma dell'AST (§3.1) | cambia la struttura di un nodo o se ne aggiunge/rimuove uno |
| `stateVersion` | forma del `PublicState` (§6.1) | cambia un campo dello stato persistibile |
| `analysisVersion` | forma di `Analysis` (§9) | cambia la shape dell'output di `analyze` |

**Cosa è breaking e cosa no.** Una modifica è **non-breaking** (non incrementa la
*major* della versione) se è *additiva e ignorabile*: nuovo campo opzionale, nuovo
`DiagnosticCode`, nuovo valore enum in coda. È **breaking** (incrementa la major) se
rimuove/rinomina un campo, cambia il tipo o la semantica di un campo esistente, o
cambia il significato di un valore enum.

**Compatibilità.**

- *Backward* (obiettivo primario): un motore nuovo deve poter **leggere uno
  `PublicState` più vecchio**. Se `state.stateVersion < corrente`, il motore applica in
  sequenza i **migratori** registrati `migrate[v→v+1]` fino alla versione corrente,
  prima di `run`. Un migratore è una funzione pura `PublicState_v → PublicState_{v+1}`.
- *Forward* (non garantita): uno `State` prodotto da un motore **più nuovo** può non
  essere leggibile da uno più vecchio; se `stateVersion > corrente`, il motore
  **rifiuta** con `UNSUPPORTED_STATE_VERSION` invece di indovinare.

**Invalidazione delle cache.** La chiave dell'`astCache` (§12.1) **deve** includere:
`astVersion`, l'hash della config dei `delimiters` e l'hash del vocabolario
(tipi/funzioni/macro/capability registrati). Così un cambio di versione o di
configurazione non fa mai ricaricare un AST incompatibile. La cache di `analyze` include
in più `analysisVersion`.

> **Perché versioni separate.** Un cambio cosmetico ad `Analysis` non deve invalidare
> gli `State` già salvati, né viceversa. Tre numeri indipendenti permettono di evolvere
> ciascun contratto al proprio ritmo, riducendo le invalidazioni a cascata.

---

## Appendice A — Codici diagnostici (normativo)

Ogni diagnostica ha la forma:

```ts
type Diagnostic = {
  code:        DiagnosticCode;   // identificatore stabile (parte del contratto)
  severity:    'error' | 'warning' | 'info';
  phase:       'createEngine' | 'tokenize' | 'parse' | 'validate' | 'analyze' | 'run' | 'driver';
  recoverable: boolean;          // la fase può proseguire (raccogliendo altre diagnostiche)?
  message:     string;           // testo umano, già localizzato/mascherato
  position?:   { start: number; end: number };  // offset nel template (assente per fasi non testuali)
  data?:       Record<string, unknown>;          // payload specifico (es. { name }, { expected, got })
};
```

`recoverable: true` significa che la fase **accumula** la diagnostica e continua (tipico
di `tokenize`/`validate`, che restituiscono *liste*); `false` significa arresto della
fase (tipico di `parse` e degli errori fatali di `run`, che producono `status:'failed'`).

| `code` | severity | phase | recoverable | `data` |
|---|---|---|---|---|
| `SYNTAX_ERROR` | error | parse | false | `{ expected? }` |
| `UNDECLARED_NAME` | error | validate | true | `{ name }` |
| `UNKNOWN_FUNCTION` | error | validate | true | `{ name }` |
| `UNKNOWN_METHOD` | error | validate | true | `{ receiverType, name }` |
| `ARITY_MISMATCH` | error | validate | true | `{ name, expected, got }` |
| `TYPE_ERROR` | error | validate | true | `{ op, expected, got }` |
| `NON_EXHAUSTIVE_MATCH` | error | validate | true | `{}` |
| `UNKNOWN_CAPABILITY` | error | validate | true | `{ capability }` |
| `POLICY_FORBIDDEN` | error | validate | true | `{ kind, name }` |
| `RESERVED_NAME` | error | createEngine | false | `{ name }` |
| `NAME_CONFLICT` | error | createEngine | false | `{ name, namespace }` |
| `CYCLE_DETECTED` | warning | analyze | true | `{ nodes }` |
| `STREAM_NOT_FULL` | info | analyze | true | `{ level, blockers }` |
| `TYPE_ERROR_RUNTIME` | error | run | false | `{ op, got }` |
| `CONSTRAINT_VIOLATION` | error | run | false | `{ id?, constraint, got }` |
| `DIVISION_BY_ZERO` | error | run | false | `{}` |
| `INCLUSION_CYCLE` | error | run | false | `{ chain }` |
| `DEPTH_EXCEEDED` | error | run | false | `{ limit }` |
| `MAX_PHASES_EXCEEDED` | error | run | false | `{ limit }` |
| `OUTPUT_LIMIT_EXCEEDED` | error | run | false | `{ limit }` |
| `TIMEOUT` | error | run | false | `{ limit }` |
| `CAPABILITY_FORBIDDEN` | error | driver | false | `{ capability }` |
| `CAPABILITY_ERROR` | error | driver | false | `{ capability, cause }` |
| `CAPABILITY_INVALID_VALUE` | error | driver | false | `{ capability, expected, got }` |
| `UNSUPPORTED_STATE_VERSION` | error | run | false | `{ found, supported }` |

> **Regola di stabilità.** I `code` sono **identificatori stabili**: non si rinominano
> (sarebbe breaking, §15); aggiungerne di nuovi è non-breaking. `message` è invece
> libero e localizzabile. I consumatori (editor, SDK) si basano sui `code`, mai sul
> testo. Nei `data` i valori provenienti da capability in `policy.redact` sono già
> **mascherati** (§13).

---

## Appendice B — Esempi di conformità (normativo)

Casi borderline con input e comportamento atteso. Un'implementazione è **conforme** se
li riproduce.

**B.1 — Requirement in rami annidati (calcolo delle fasi).**

```
${ a == 'x' ? (b == 'y' ? need({id:'c', type:string(), capability:'user'}) : '') : '' }
```
`c` è governato da due condizioni (su `a` e su `b`). Atteso: `requirementGraph` con archi
`a→c` e `b→c`; `phase(c) = 1 + max(phase(a), phase(b))`. Se `a`, `b` sono incondizionati
(fase 1), allora `phase(c) = 2`; `maxPhases ≥ 2`.

**B.2 — Need in un ramo non preso (non emesso).**

```
${ flag ? need({id:'x', type:string(), capability:'user'}) : 'ok' }
```
Con `resolved = { flag: false }`: il ramo `then` non è valutato (lazy, §5), quindi `x`
**non** genera `Need`. Atteso da `run`: `status:'completed'`, `output:'ok'`,
`pending:[]`. Con `flag: true` e `x` assente: `status:'waiting'`, `pending:[x]`.

**B.3 — `match` non esaustivo.**

```
${ n match { 1 => 'uno', 2 => 'due' } }
```
Nessun caso `*` e casi non esaustivi su `int`. Atteso: `validate` ritorna
`[{ code:'NON_EXHAUSTIVE_MATCH', severity:'error', phase:'validate', recoverable:true }]`.
Con un ramo `* => 'altro'` aggiunto: nessuna diagnostica.

**B.4 — Capability non registrata.**

```
${ need({ id:'x', type:string(), capability:'ghost' }) }
```
`ghost` non è in `createEngine.capabilities`. Atteso: `validate` →
`[{ code:'UNKNOWN_CAPABILITY', data:{capability:'ghost'}, recoverable:true }]` (statico,
**prima** di qualunque `run`).

**B.5 — Inclusione ciclica.**

```
// template 'a':  @{ABSORB('b')}
// template 'b':  @{ABSORB('a')}
```
`expand` segue la catena di inclusione e rileva il ciclo. Atteso: `status:'failed'` con
`{ code:'INCLUSION_CYCLE', phase:'run', recoverable:false, data:{ chain:['a','b','a'] } }`.
Lo stesso ciclo è anche segnalato *staticamente* da `analyze` in `potentialCycles`.

**B.6 — Macro di layout adiacenti e conflitti di rimozione.**

```
riga1
${ vuoto }@{REMOVE_LINE}
${ x }@{REMOVE_RIGHT(2)}AB
```
Atteso (post-pass `finalize`, §10.2): la seconda riga è rimossa interamente
(`REMOVE_LINE` sulla riga dello slot, dopo che `vuoto` si è risolto a `''`); sull'ultima
riga `REMOVE_RIGHT(2)` rimuove sé stesso **e** i due caratteri a destra (`AB`), lasciando
il solo valore di `x`. **Conflitti**: se due marcatori insistono sullo stesso intervallo,
si applicano in **ordine di posizione** sinistra→destra ricalcolando gli offset; una
rimozione che cadrebbe dentro un intervallo già rimosso è un *no-op* (non è errore).

> **Uso degli esempi.** Questi casi sono pensati come **fixture di test di conformità**:
> input → (AST atteso | diagnostics attese | stati intermedi | output). Ampliarli è il
> modo più diretto per far convergere implementazioni indipendenti.