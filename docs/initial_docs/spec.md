# SPEC.md — Specifica di *seebo .js*

> **Cos'è questo documento.** È la **specifica di riferimento** di *seebo * ("Suspendable
Evaluation Engine Built with Opus"): il linguaggio, il suo modello di esecuzione e
> l'API pubblica. 
>
> **Cos'è seebo , in una frase.** seebo  non è un template engine che supporta la
> risoluzione multi-fase: è un **motore di valutazione sospendibile** (*resumable
> evaluation engine*) in cui il rendering di template è una delle applicazioni
> possibili. Il documento finale è soltanto *l'ultimo stato di una conversazione* tra
> il motore e un insieme di risolutori esterni.
>
> **Struttura.** Parte 1: il linguaggio (modello, tipi, espressioni, requirement,
> macro). Parte 2: l'API (analisi statica, esecuzione, estensibilità, esempio
> end-to-end).

---

# Parte 1 — Il linguaggio

## 1.1 Modello concettuale

seebo  elabora un **documento**: una stringa di testo qualsiasi che può contenere
**slot**. Uno slot è una porzione di testo che, durante la **valutazione**, viene
**interamente sostituita** (sigillo e parentesi inclusi) con qualcos'altro.

Quattro principi fondanti governano tutto il resto. Li enunciamo subito perché molte
scelte successive ne discendono.

1. **Ogni valore è tipato.** Internamente non si lavora su "stringhe e basta", ma su
   **oggetti tipati** (interi, decimali, booleani, stringhe, date, **durate**, oggetti
   JSON, array). La conversione in testo (*stringhizzazione*) avviene **solo alla
   fine**, quando il valore di uno slot va inserito nel documento. *Perché*: tenere il
   tipo fino all'ultimo elimina conversioni ripetute e ambiguità (una data resta una
   data finché non la si formatta) e permette controlli di tipo significativi.

2. **La valutazione è priva di effetti collaterali** (*pure*). Valutare una formula
   non modifica lo stato del motore: non esistono assegnazioni, contatori, mutazioni.
   Le "dichiarazioni" (variabili, requirement) sono raccolte **staticamente** dal
   testo, non come effetto dell'esecuzione. *Perché*: la purezza è ciò che rende
   possibile l'**analisi statica** (§2.3) e la **memoizzazione**, e rende il motore
   sicuro da eseguire anche sul client.

3. **Il linguaggio è volutamente non Turing-completo.** Niente cicli illimitati,
   niente ricorsione utente, niente funzioni definite dall'utente. L'unica forma di
   "ripetizione" è l'inclusione di template, che è **limitata** (profondità massima,
   anti-ciclo). *Perché*: la **totalità** (ogni valutazione termina) e l'analizzabilità
   statica si ottengono *solo* rinunciando alla potenza di calcolo piena.

4. **La valutazione è sospendibile.** Valutare un'espressione non produce soltanto un
   *valore* o un *errore*: può produrre anche un **bisogno** (`Need`), cioè la richiesta
   di un dato che il motore non possiede ancora. In quel caso la valutazione **si
   sospende** invece di fallire, e potrà essere **ripresa** quando il mondo esterno
   avrà soddisfatto quel bisogno. *Perché*: è ciò che distingue seebo  da Jinja o
   Liquid. Un template non è una funzione "tutto-o-niente": è la descrizione di una
   **conversazione** tra il motore e un insieme di risolutori esterni (§1.9).

> **Tesi centrale.** Il documento finale è soltanto **l'ultimo stato della
> conversazione**. La risoluzione multi-fase (chiedere input a schermo) è una
> *strategia di orchestrazione* costruita sopra il modello sospendibile, non la sua
> essenza.

## 1.2 Slot e delimitatori

Uno slot inizia con un **sigillo** (`$`, `#` o `@`) seguito da `{` e termina con `}`:

```
${ formula }     → Dollar Slot: contiene una formula, valutata e sostituita.
#{ commento }    → Hash Slot: contiene un commento, rimosso dal documento.
@{ macro }       → At Slot: contiene una macro, operazione a livello documento.
```

**Regola di bilanciamento.** All'interno di uno slot, le parentesi graffe e quadre e
gli apici devono essere bilanciati; il lexer riconosce la chiusura `}` di primo
livello tenendo conto di stringhe e parentesi annidate.

**Escaping (obbligatorio).** I sigilli `${`, `#{`, `@{` possono comparire nei testi
ospite — in particolare **`${` collide con i *template literal* di JavaScript e con le
variabili di shell**. Per emettere letteralmente queste sequenze si premette `\`:
`\${`, `\#{`, `\@{` producono `${`, `#{`, `@{`.

> **Nota di progettazione (collisione).** La graffa singola è più leggera della tripla
> `{{{…}}}`, ma il rischio di falsi positivi è reale (JSON, JS, shell). Due
> mitigazioni: (a) il sigillo `$`/`#`/`@` *prima* della graffa riduce già molto i
> falsi positivi; (b) i delimitatori sono **configurabili** in `createEngine` (§2.2),
> così un documento pieno di `${}` JavaScript può scegliere un sigillo diverso. La
> regola di escaping resta la rete di sicurezza.

## 1.3 Il sistema di tipi

Ogni valore che circola nella valutazione è un **oggetto** caratterizzato da tre
attributi:

- **type** — il tipo. Base: `int`, `float`, `bool`, `string`, `datetime`, `duration`.
  Composti: `object` (un JSON), `array` (sequenza ordinata di oggetti).
- **format** — *come* l'oggetto viene reso in stringa. È un **oggetto a chiavi
  nominate** (non un array posizionale), con un default per tipo.
- **constraints** — i **vincoli di validità** a cui l'oggetto deve sottostare. Oggetto
  a chiavi nominate, con default per tipo.

| Tipo | `format` (default) | `constraints` (default) | Stringhizzazione |
|---|---|---|---|
| `int` | `{ thousands: '' }` | `{ min, max }` (assenti = limiti macchina) | cifre con separatore migliaia |
| `float` | `{ decimalSep: ',', thousands: '' }` | `{ min, max, precision: 2 }` | arrotonda a `precision` decimali, separatore `decimalSep` |
| `bool` | `{ trueLabel: 'true', falseLabel: 'false' }` | — | `trueLabel`/`falseLabel` |
| `string` | — (già stringa) | `{ minLen, maxLen }` | sé stessa |
| `datetime` | `{ pattern: 'YYYY-MM-DDTHH:mm:ssZ' }` | `{ min, max, precision: 'second' }` | data formattata col `pattern` |
| `duration` | `{ pattern: 'HH:mm:ss' }` | `{ min, max, precision: 'second' }` | span formattato col `pattern` |
| `object` | — | — | JSON serializzato |
| `array` | — | `{ minLen: 0, maxLen, values }` | JSON serializzato |

Note semantiche importanti:

- **Decimali del float: una sola fonte di verità.** Il numero di decimali è **solo**
  `constraints.precision`; il `format` porta unicamente i separatori. Questo elimina
  la possibilità che due fonti si contraddicano.
- **`datetime.precision`** (`'year'|'month'|'day'|'hour'|'minute'|'second'`) indica la
  **granularità significativa** della data (a cosa troncarla / fino a dove validarla);
  il `pattern` indica **come** visualizzarla. Concetti distinti. Le precisioni sono
  **ordinate dalla più grossolana alla più fine**: `year < month < day < hour < minute
  < second`. Quando un'operazione combina due `datetime` (o cala la precisione di una
  durata), la precisione del risultato è la **più fine** (massima nell'ordine) tra gli
  operandi: così non si perde mai informazione di granularità.
- **`array.values`**, se presente, è l'insieme dei valori ammessi come elementi
  (`values: [1,2,3]` ⇒ l'array può contenere solo quei valori). È la base per le liste
  a scelta (§1.7).

> **Nota di progettazione (`duration`).** Una durata rappresenta uno *span* di tempo
> (3 ore, 12 giorni), non un *istante* (quello è `datetime`). È **con segno** (può
> essere negativa) e internamente è un numero di **secondi**, coerente con la
> precisione minima `'second'` di `datetime`. Si misura **solo in unità di lunghezza
> costante** — secondi, minuti, ore, giorni, settimane — mentre **mesi e anni sono
> volutamente esclusi**, perché non hanno durata fissa (un mese va da 28 a 31 giorni,
> un anno può essere bisestile): ammetterli renderebbe l'aritmetica delle durate
> ambigua e *impura* (dipenderebbe dall'istante a cui sono ancorate). Per gli
> spostamenti "di calendario" si usa l'aritmetica su `datetime` (§1.4), che *è*
> ancorata a un istante e può quindi essere calendario-consapevole.
>
> Il `format.pattern` di una durata usa i token `W` (settimane), `D` (giorni),
> `H`/`HH` (ore), `m`/`mm` (minuti), `s`/`ss` (secondi). Regola chiave: **il token più
> a sinistra (l'unità più grande del pattern) accumula tutte le unità superiori**; i
> token successivi sono componenti modulari. Esempio su una durata di 50 ore:
> `HH:mm:ss` → `50:00:00`, mentre `D HH:mm:ss` → `2 02:00:00`. La `precision` nei
> constraints tronca la durata alla sua unità minima prima di validarla/stringhizzarla.

## 1.4 Espressioni: operatori e precedenze

Una **formula** è un'**espressione**: una combinazione di valori e operatori che
produce un oggetto. Gli operatori **infissi** (scritti *tra* gli operandi), in ordine
di **precedenza decrescente** (in alto legano più forte):

| Liv. | Operatori | Assoc. | Note di tipo |
|---|---|---|---|
| 1 | `.` (accesso membro / metodo) | sx | vedi §1.5 |
| 2 | `not x`, `-x` (unari) | dx | `not`: bool; `-`: int/float/**duration** |
| 3 | `*` `/` | sx | numeri; **scalatura durate** (vedi sotto); `/` per 0 ⇒ errore |
| 4 | `+` `-` | sx | numeri, stringhe, **date e durate** (vedi sotto) |
| 5 | `<` `<=` `>` `>=` | sx | `(num,num)`, `(datetime,datetime)`, `(duration,duration)` |
| 6 | `==` `!=`, `in` | sx | su tipi uguali; `in`: `x in array` ⇒ bool |
| 7 | `and` | sx | bool, **lazy** (corto-circuito) |
| 8 | `or` | sx | bool, **lazy** |
| 9 | `??` (coalesce) | dx | "primo non vuoto", **lazy** |
| 10 | `cond ? a : b` (ternario) | dx | `cond` bool, **lazy** sui rami |

**Regole di tipo per `*` e `/` (Liv. 3):**

- `int/float * int/float` → prodotto (mix ⇒ `float`); idem per `/` (sempre `float`).
- `duration * int/float` e `int/float * duration` → `duration` (scalatura).
- `duration / int/float` → `duration` (scalatura). `duration / duration` → `float`
  (rapporto adimensionale: "quante volte ci sta").

**Regole di tipo per `+` e `-` (Liv. 4):**

- `int/float ± int/float` → somma/differenza numerica (mix ⇒ `float`).
- `string + string` → concatenazione. `string + <non-string>` → **errore** (niente
  coercizione implicita; per concatenare un numero lo si rende esplicito:
  `'a' + string(1)`).
- **Date e durate (cuore del modello temporale):**
  - `datetime - datetime` → **`duration`** = lo span tra i due istanti (con segno).
  - `datetime + duration` / `datetime - duration` / `duration + datetime` → `datetime`
    (istante spostato).
  - `duration + duration` / `duration - duration` → `duration`.
  - `datetime + datetime` → **errore** (sommare due istanti non ha significato).
- **Gli `int` non si mescolano con i tipi temporali.** `datetime ± int`,
  `duration ± int`, `int ± duration` sono **errori**: per spostare una data o comporre
  una durata si passa **sempre** da `duration` (es. `dt + duration(86400)`). Questo
  toglie ogni ambiguità sul significato dell'intero ("secondi? giorni?").
- Ogni altra combinazione → **errore di tipo**.

> **Nozione di «vuoto» (per `??` e per i requirement opzionali).** Diversi punti della
> specifica parlano di valore "vuoto". La definizione è: sono vuoti la **stringa
> vuota** `''`, l'**array vuoto** `[]` e l'**oggetto vuoto** `{}`. **Non** sono vuoti
> `0`, `0.0`, `false` né una `duration` di 0 secondi: sono valori legittimi. Così
> `x ?? y` restituisce `x` se non vuoto, altrimenti `y`; e un requirement opzionale non
> soddisfatto (che si risolve in `''`) viene correttamente "scavalcato" da `??`.

**`match`** è una forma primaria (non un operatore infisso):

```
soggetto match {
  valore1 => risultato1,
  valore2 => risultato2,
  *       => default
}
```

Confronta `soggetto` con ciascun `valoreK` (uguaglianza per tipo) e restituisce il
primo `risultatoK`; `*` è il default (obbligatorio se i casi non sono esaustivi). È
**zucchero** per una catena di ternari, quindi non aggiunge potere di calcolo né
rischi di terminazione.

> **Teoria — perché queste precedenze.** Una tabella esplicita rende la grammatica
> **non ambigua**: ogni espressione ha un solo albero. La *lazy evaluation* di
> `and/or/??/?:`/`match` non è solo un'ottimizzazione: evita di valutare rami non
> necessari e quindi **evita di generare `Need` inutili** (§1.9).

## 1.5 Produttori e trasformatori (la regola di coerenza)

Per coerenza adottiamo **una regola unica** su come si scrivono le operazioni:

- **Produttori** → **funzioni o namespace** `nome(...)`. Producono un valore *da zero*
  (non hanno un "soggetto" su cui operare).
- **Trasformatori** → **metodi** `valore.nome(...)`. Operano *su* un valore esistente
  (il "soggetto" a sinistra del punto).

Il criterio è semantico: *chi crea* è una funzione, *chi trasforma* è un metodo. Ne
guadagnano la leggibilità (le trasformazioni si leggono da sinistra a destra, come una
*pipeline*) e il parser (i metodi sono postfissi, niente precedenze da gestire).

**Produttori (funzioni / namespace):**

```
// Costruttori di oggetti tipati  (object(v) costruisce il tipo `object` da un JSON)
int(v)  float(v)  bool(v)  string(v)  datetime(v)  duration(secondi)  object(v)  array(v)

// Date e durate
now()                     // istante corrente → datetime
date(pattern, testo)      // interpreta 'testo' secondo 'pattern' → datetime
duration(secondi)         // durata da un numero (con segno) di secondi → duration

// Accesso al mondo esterno (§1.6)
need(descrittore)         // richiesta di un valore esterno → il valore, o un Need se assente

// Binding di valore (§1.7) — descrittore = un type builder
bind(nome, tipo)
// Dichiarazione lazy di need/action (§1.7), riusabile per id
prepare(need(...) | action(...))

// Librerie (namespace, caricate pigramente)
fake.int()   fake.full_name()   fake.email()   ...
```

Poiché il costruttore di durata accetta **solo** secondi, le altre unità si esprimono
con un prodotto leggibile: `duration(30 * 86400)` (30 giorni), `duration(90 * 60)`
(90 minuti). Semplice e senza casi speciali.

> **Identificatori e parole riservate.** Ogni nome che l'applicazione *introduce* —
> tipi, funzioni, macro, librerie e **capability** custom (§2.6) — è un
> **identificatore** soggetto a due regole: (a) non può coincidere con una **parola
> riservata** del linguaggio; (b) deve essere **unico nel proprio spazio dei nomi** (in
> particolare produttori, librerie e capability condividono lo stesso spazio: due di
> essi non possono chiamarsi uguale, perché si invocano tutti come `nome(...)`). Le
> parole riservate sono:
>
> - **operatori e forme**: `and`, `or`, `not`, `in`, `match`
> - **literali**: `true`, `false`
> - **tipi builtin**: `int`, `float`, `bool`, `string`, `datetime`, `duration`, `object`, `array`
> - **produttori builtin**: `now`, `date`, `need`, `bind`
> - **macro builtin**: `ABSORB`, `MERGE`, `COLLAPSE`, `REMOVE_LINE`, `REMOVE_LEFT`, `REMOVE_RIGHT`
>
> (I tipi builtin fungono anche da produttori — `int(v)`, `array(v)`, … — quindi una
> capability non può, ad esempio, chiamarsi `array`.) La violazione è segnalata **alla
> creazione del motore** (`createEngine`) e, per i riferimenti nel testo, da `validate`.

**Trasformatori (metodi):**

```
// string
s.upper()  s.lower()  s.trim()  s.reverse()  s.len()
s.left(n)  s.right(n)  s.remove(x)  s.replace(x,y)
s.contains(x)  s.startsWith(x)  s.endsWith(x)

// array
a.min()  a.max()  a.sum()  a.avg()  a.first()  a.last()  a.get(i)  a.len()  a.reverse()

// int / float
n.abs()  n.round()  n.floor()  n.ceil()

// datetime
d.year()  d.month()  d.day()  d.hour()  d.minute()  d.second()   // → int (componente)
d.truncate('month')          // → datetime troncata alla precisione indicata
d.add(duration)  d.sub(duration)   // → datetime (forma metodo dell'aritmetica §1.4)

// duration
dur.totalSeconds()  dur.totalMinutes()  dur.totalHours()  dur.totalDays()  dur.totalWeeks()  // → float
dur.weeks()  dur.days()  dur.hours()  dur.minutes()  dur.seconds()   // → int (componenti)
dur.abs()  dur.neg()  dur.isNegative()
dur.round('hour')  dur.truncate('day')

// object
o.campo            // accesso a chiave statica (identificatore)
o.get('chiave')    // accesso a chiave dinamica/con caratteri speciali
o.keys()  o.values()

// presentazione / vincolo (su qualunque oggetto, immutabili)
x.format(oggettoFormato)        // → nuovo oggetto con quel formato
x.constraints(oggettoVincoli)   // → nuovo oggetto con quei vincoli
```

Sui metodi di `duration` si distinguono i **totali** (la durata intera espressa in una
unità, come `float`) dai **componenti** (la scomposizione "da orologio", come `int`,
col segno applicato solo al componente più alto). Esempio su `duration(50 * 3600)`
(50 ore):

```
${ duration(50 * 3600).totalHours() }   // → 50      (totale)
${ duration(50 * 3600).days() }         // → 2       (componente: 2 giorni…)
${ duration(50 * 3600).hours() }        // → 2       (…e 2 ore di resto)
```

Esempi di lettura "a pipeline":

```
${ array([3,1,2]).min() }
${ float(1234.3456).constraints({ precision: 2 }) }            // → "1234,35"
${ (deadline - now()).totalHours().round() }                  // ore mancanti alla scadenza
${ (fine - inizio).format({ pattern: 'HH:mm:ss' }) }          // tempo-macchina HH:mm:ss
${ (now() - ultimo_accesso) > duration(30 * 86400)
     ? 'Account inattivo' : 'Attivo' }                        // logica temporale
```

> **Nota (`.year()` ritorna int).** Un componente di data è un numero: `d.year()`
> ritorna un **int**. Per una data "troncata" si usa `d.truncate('year')`.
>
> **Nota (`.format()/.constraints()` ritornano l'oggetto).** Sono *builder
> immutabili* che ritornano un nuovo oggetto tipato; la stringhizzazione avviene una
> sola volta, all'emissione dello slot (principio 1 di §1.1).

## 1.6 Requirement, Capability e Need (il modello di esecuzione)

Questa è la sezione che distingue seebo . La trattiamo per gradi.

### Value vs Requirement

Non è l'utente che "riempie variabili". È il **template che dichiara dei
Requirement** — cose di cui ha bisogno per completarsi — e qualcuno *fuori* dal
motore li **soddisfa**. La distinzione fondamentale è:

- un **Value** è un dato già posseduto dal motore (un literal, il risultato di un
  calcolo puro, o un requirement già soddisfatto);
- un **Requirement** è la *descrizione* di un dato che serve, **indipendentemente da
  chi e come** lo fornirà.

```
${ need({ id: 'cliente', type: object(), capability: 'crm', label: 'Cliente' }) }
```

Il template **non sa** se quel `cliente` arriverà da un form, da una query SQL, da un
ERP, da una chiamata a un LLM o da un tool MCP. Sa solo *cosa* gli serve. Un
requirement, oltre a produrre il proprio valore *sul posto*, lo **registra per nome**
(`id`): lo si può quindi richiamare altrove con `${ cliente.nome }`, senza ridichiararlo.

### Il Requirement Descriptor

Un requirement si dichiara con un **descrittore**, un oggetto ricco che permette al
client di costruire UI e orchestrazioni intelligenti. **`id` e `capability` sono
obbligatori**; la sugar `cap('id')` fornisce entrambi (`input('amount')`). Il `type` può
essere ereditato dal **contratto della capability** (vedi sotto); gli altri campi sono
facoltativi.

| Campo | Obbl. | Significato |
|---|---|---|
| `id` | ✓ | identificatore univoco del requirement (chiave nello stato). *La sugar `cap('id')` lo fornisce come stringa* |
| `type` | | il tipo seebo atteso, come *builder* (`string()`, `array().constraints({…})`): porta con sé format, constraints ed eventuale default. *Se omesso, è ereditato dal contratto della capability, altrimenti `string()`* |
| `capability` | ✓ | la **capacità** che lo può soddisfare (`user`, `crm`, `weather`, …) |
| `label` | | etichetta breve per la UI (ereditabile dal contratto della capability) |
| `description` | | testo esteso / aiuto (ereditabile dal contratto della capability) |
| `optional` | | se `true`, può restare non soddisfatto (→ valore vuoto) |
| `priority` | | ordinamento/urgenza suggeriti al client |
| `group` | | raggruppamento logico (es. una "sezione" del form) |
| `args` | | dati passati **opachi** al risolutore; un valore può referenziare un altro binding (§2.4), risolto prima e passato al provider |
| `phase` | | *(calcolato da `analyze`, non scritto a mano)* fase in cui diventa attivo |

> **Contratto della capability (§2.2).** Una capability registrata con
> `defineCapability({ type, label, description, resolve })` dichiara un **contratto**
> statico che la sugar `cap('id')` eredita: il template non deve ripetere il tipo. In caso
> di conflitto **vince il template**. Una capability registrata come semplice funzione non
> porta contratto (il `type` ripiega su `string()`).

> **Nota di coerenza (cardinalità).** Non esiste un campo `multiple`: la cardinalità si
> esprime con il **tipo**. Un requirement che raccoglie più valori è di tipo `array`
> (eventualmente con `constraints.values`/`maxLen`); uno scalare è di tipo base. Questo
> riusa il sistema di tipi invece di aggiungere un meccanismo parallelo (vedi anche le
> liste a scelta, §1.7).

### Capability

Una **Capability** è un risolutore registrato nell'engine che sa soddisfare i
requirement di una certa categoria. Il template conosce solo la **capacità**, non
l'implementazione che la realizza:

```
capability 'crm'      →  lookup su ERP / CRM
capability 'file'     →  un file picker
capability 'user'     →  una domanda all'utente
capability 'weather'  →  una API meteo
```

*Perché*: si può **sostituire l'intero backend senza toccare i template**.

> **Nessuna capability è builtin.** seebo  non assume l'esistenza di `user`, `env`,
> `source` o altro: sarebbe una scelta arbitraria che tradirebbe la genericità del
> modello. L'**intero set di capability utilizzabili è definito dall'applicazione** in
> `createEngine` (§2.2). Un requirement che cita una capability non registrata è un
> **errore di validazione** statico (§1.10).

### Zucchero sintattico: una capability è anche un produttore

Scrivere ogni volta `need({ capability:'crm', … })` è verboso. Per questo, **nel
momento in cui una capability viene registrata** in `createEngine`, il suo nome diventa
automaticamente disponibile come **produttore**: invocarlo equivale a un `require` con
quella `capability` già impostata.

```
crm({ id:'cliente', type:object(), label:'Cliente' })
// ≡ need({ id:'cliente', type:object(), capability:'crm', label:'Cliente' })
```

`crm` **non è builtin**: esiste come produttore *solo* perché l'applicazione ha
registrato la capability omonima. Lo zucchero è puramente sintattico e viene risolto
**staticamente** (il campo `capability` è iniettato dal nome del produttore), quindi non
intacca l'analizzabilità. La forma esplicita `need(...)` resta sempre valida e
rimane la base concettuale; lo zucchero è solo un'abbreviazione.

Poiché il nome della capability diventa un produttore, esso deve rispettare le **parole
riservate** e l'unicità nello spazio dei nomi (§1.5): non si può registrare una
capability chiamata `array`, `require`, `match`, ecc., né omonima di un'altra
capability/funzione/libreria.

### Need: il terzo esito della valutazione

Durante la valutazione, ogni nodo dell'AST produce **uno di tre esiti**:

```
EvaluationResult  =  Value  |  Need  |  Error
```

Quando la valutazione incontra un requirement il cui valore **non è ancora nello
stato**, non fallisce: produce un **`Need(requirement)`** e **sospende** quel ramo. I
`Need` raccolti in una passata sono esattamente ciò che il mondo esterno deve fornire
per far procedere la conversazione (§1.9). È questo terzo esito — non il valore, non
l'errore, ma *il bisogno* — la vera innovazione del modello.

### Requirement ≠ Dependency

Sono concetti diversi e vanno tenuti distinti:

- **Dependency**: "A dipende da B" — relazione *interna* tra due nodi/valori del
  template (es. un ramo `?:` la cui condizione usa `paese`).
- **Requirement**: "serve `cliente`" — richiesta *verso l'esterno*.

Un requirement può non avere dipendenze (è richiesto sempre); una dipendenza può non
generare requirement (entrambi i membri sono valori puri). Il **Requirement Graph**
(§2.3) mette in relazione i requirement *attraverso* le dipendenze: un arco
`cliente → fattura` significa "fattura serve solo in un ramo la cui condizione dipende
da cliente". Il client può scegliere se risolvere tutto insieme o un livello alla
volta: **il motore resta identico**.

## 1.7 Dichiarazioni, requirement e liste a scelta

### Dichiarazioni: `need`, `bind`, `prepare`

Tre forme dichiarano ciò che il template usa; tutte si leggono poi **per nome** (`${ nome }`),
e un riferimento a un nome non dichiarato è `UNDECLARED_NAME`:

- **`need(descrittore)`** — un requirement: valore che può arrivare *durante* la conversazione,
  via capability. Usato **inline** è **eager**: chiede il valore e lo renderizza dove appare.
  Genera un `Need` finché non è soddisfatto. La sugar `cap('id')` è la forma breve
  (`input('amount')` ≡ `need({ id:'amount', capability:'input' })`).
- **`bind('api_key', string())`** — un **valore puro** con nome: noto *prima* della valutazione
  (config, segreto, costante d'ambiente). **Immutabile**. Il secondo argomento è un *type builder*;
  se manca, si usa il `default` del descrittore o si segnala errore. `bind` accetta **solo** un
  tipo, non `need`/`action`.
- **`prepare(need(...) | action(...))`** — dichiara un need/action **lazy**, riusabile per il
  proprio `id` (nel descrittore). Non emette nulla e **non** attiva nulla nel punto del `prepare`:
  il need viene chiesto, e l'action attivata, solo dove il loro `id` è referenziato.

```
bind('api_key', string())                                       // valore statico
need({ id:'nome', type:string(), capability:'user', label:'Il tuo nome' })  // requirement (eager, inline)
prepare(need({ id:'nome', capability:'user' }))                 // requirement (lazy)
prepare(action({ id:'ticket', type:'jira.createIssue', input:{ … } }))  // effetto (lazy)
${ nome }                                                      // riferimento per nome
```

Il **descrittore di un binding di valore** (il secondo argomento di `bind`, un *type
builder*) è un oggetto tipato che fissa `type`, `format`, `constraints` ed eventuale
`default`. Se è un semplice `string()` senza metodi, il default è `string` senza vincoli.
Per i requirement lo stesso ruolo è svolto dal campo `type` del Requirement Descriptor,
che è un *builder* di tipo (coerenza con i binding di valore).

> **Dove vive `default`.** Il **descrittore tipato** — l'oggetto prodotto dai builder
> `string()`, `array()`, `int()`, … — ha la forma `{ type, format, constraints,
> default? }`. Il `default` è un **campo di pari livello** del descrittore, *non* sta
> dentro `constraints` (i constraints sono regole di validità, il default è un valore di
> ripiego) e *non* è un campo a sé del Requirement Descriptor (che lo riceve attraverso
> il proprio `type`). Lo si imposta col builder, es. `string().default('N/D')` oppure
> passando l'oggetto `{ type:'string', default:'N/D' }`. Conseguenza: `bind` e `need`
> ottengono il default per la **stessa** via, ed è quello usato al punto (1) della
> precedenza di risoluzione qui sotto.

### Regola di *scope statico*

Le dichiarazioni (`need`, `bind`, `prepare`) sono **raccolte staticamente** dal testo del
template (e dei template inclusi), **indipendentemente** dal fatto che il ramo in cui
compaiono venga poi valutato. Di conseguenza:

- un riferimento `${ nome }` è **valido** se esiste *da qualche parte* una
  dichiarazione corrispondente;
- un identificatore **non dichiarato** è un **errore di validazione** statico;
- un requirement **dichiarato ma non soddisfatto** si risolve secondo questa
  precedenza: (1) se il suo `type` porta un **`default`**, vale il default; (2)
  altrimenti, se è **`optional`**, vale il valore **vuoto** del tipo (`''`, `[]`, `{}`);
  (3) altrimenti, finché è *attivo*, genera un **`Need`** (e il documento resta in
  `waiting`). Un requirement **non attivo** (ramo non preso) non genera mai `Need`: si
  comporta come ai punti (1)/(2). In nessun caso la valutazione si interrompe.

> **Teoria — perché lo scope statico.** Un modello *flow-sensitive* (il requirement
> "esiste" solo se il ramo che lo dichiara viene eseguito) non è analizzabile
> staticamente: per sapere se un nome è definito bisognerebbe *eseguire* il programma.
> Ciò contraddirebbe la purezza e impedirebbe ad `analyze` di generare il form in modo
> affidabile. Lo **scope statico** preserva l'analizzabilità *e* l'ergonomia "dichiara
> una volta, riferisci per nome"; il caso "mai chiesto" è gestito dal valore vuoto
> invece che da un errore. `analyze` calcola *quali* requirement sono attivi date le
> risposte correnti, e solo quelli generano `Need`.

### Liste a scelta (singola e multipla)

Si ottengono come **requirement** con `type` di tipo `array` e il vincolo `values`:

```
${ need({ id:'provider', capability:'user', label:'Provider',
             type: array().constraints({ values:['AWS','Azure','GCP'], minLen:1, maxLen:1 }) }) }
// maxLen 1 ⇒ selezione singola; maxLen assente o >1 ⇒ multi-selezione
```

Questo riusa il sistema di tipi/vincoli invece di introdurre tipi speciali
`INPUT_LIST`/`MULTI_SELECT`: meno superficie, più coerenza.

## 1.8 Macro (`@{}`) e fasi di elaborazione

Le macro sono operazioni a **livello di documento**, non valori. Due famiglie,
eseguite in **fasi diverse**:

**(a) Aggregatori — fase di composizione (pre-pass).** Compongono il documento prima
di valutare le formule, attingendo dall'insieme di template forniti all'engine (§2.5):

```
@{ABSORB('nome_template')}
// sostituisce lo slot col contenuto del template indicato (poi risolto a sua volta)

@{MERGE('pattern', 'separatore')}
// concatena (con 'separatore') tutti i template il cui nome combacia 'pattern'
```

> **Nota (pattern, non regex arbitraria).** Le regex arbitrarie introducono rischio di
> **ReDoS** (backtracking catastrofico), pericoloso lato client. Si usa un **glob**
> ancorato (`item_*`, `*_footer`) o, se serve la regex, un motore *linear-time*
> (RE2-like) con timeout.

**(b) Layout / rimozione — fase di rifinitura (post-pass).** Ripuliscono il testo dopo
la risoluzione:

```
@{REMOVE_LINE}        // rimuove l'intera riga che contiene questo slot
@{COLLAPSE}           // collassa più righe vuote adiacenti in una sola
@{REMOVE_LEFT(n)}     // rimuove sé stesso e n caratteri alla sua sinistra
@{REMOVE_RIGHT(n)}    // rimuove sé stesso e n caratteri alla sua destra
```

> **Nota (macro di bordo posizionali).** Lo slot macro è un *marcatore* che, alla
> rifinitura, rimuove sé stesso e N caratteri dal lato indicato della *propria
> posizione*. Per rifilare i caratteri attorno al **valore** di una formula (es.
> togliere le virgolette attorno a un JSON iniettato), si colloca il marcatore
> **adiacente** alla formula.

## 1.9 Il template come conversazione

Mettendo insieme §1.1 (principio 4) e §1.6, ecco il modello operativo completo.

Una **conversazione** è la successione di stati attraverso cui passa la valutazione:

```
Created ──▶ Running ──▶ Waiting(Need…) ──▶ Running ──▶ Waiting(Need…) ──▶ … ──▶ Completed
```

- **Created**: c'è un template e uno stato iniziale (eventuali valori già noti). È lo
  stato prodotto da `start`, che concretamente porta `status: 'running'`.
- **Running**: il motore valuta il più possibile usando *solo* ciò che ha nello stato.
- **Waiting**: la valutazione ha prodotto uno o più `Need`; il motore si **sospende** e
  li espone. Un **risolutore esterno** (umano, AI, API, cache, DB…) li soddisfa.
- **Completed**: nessun `Need` residuo; il documento è interamente risolto.

A questi si aggiunge lo stato terminale **Failed** (`status: 'failed'`), in cui la
conversazione si arresta per un errore fatale (violazione di tipo a runtime, ciclo
d'inclusione, limite superato): lo stato porta le `diagnostics` relative. I nomi
concettuali qui usati corrispondono ai valori dell'enum `status` di §2.4
(`running`/`waiting`/`completed`/`failed`).

Punti chiave:

- Il template, **concettualmente**, viene **sospeso e ripreso**, non rieseguito da
  capo. Attenzione però: "sospeso e ripreso" è il *modello*, non un obbligo
  implementativo. La strategia **di default è anzi la più semplice — rivalutare l'intero
  documento a ogni `run`** — del tutto lecita perché la valutazione è pura e
  idempotente: con gli stessi `resolved` produce lo stesso esito. Riprendere da un
  checkpoint (continuation) o rivalutare solo le parti impattate sono *ottimizzazioni
  facoltative*, non necessarie per una prima implementazione conforme. La scelta è
  invisibile al chiamante.
- Lo **stato è un oggetto serializzabile**: si può salvare in Redis, in un database,
  nel browser, in un file, in una sessione — e riprendere la conversazione altrove.
- La risoluzione **multi-fase** (chiedere input a schermo, una schermata per giro) è
  *un caso particolare*: corrisponde a un risolutore esterno che è l'utente.

## 1.10 Errori e validità

Una formula è **non valida** quando:

- usa un **identificatore non dichiarato** (§1.7);
- chiama una **funzione/metodo inesistente** o con **arità** sbagliata;
- viola una **regola di tipo** di un operatore (§1.4) con tipi noti staticamente;
- un valore **viola i propri `constraints`**;
- cita una **capability non registrata** nell'engine;
- una **inclusione** crea un **ciclo** o supera la **profondità massima**.

I controlli che dipendono solo dalla struttura/tipi/capability li fa `validate`
(statico, senza dati); quelli che dipendono dai valori reali emergono in `run`.

## 1.11 Determinismo e limiti

- I produttori **non deterministici** (`now`, `fake.*`) leggono un **orologio** e un
  **seed** dal contesto. Se l'applicazione li fissa (§2.2), l'output è riproducibile
  (anteprime coerenti, test). Altrimenti usano orologio reale e RNG di sistema.
- La valutazione è soggetta a **limiti** configurabili: profondità massima di
  inclusione, numero massimo di fasi, dimensione massima dell'output, timeout. Servono
  a garantire **terminazione e sicurezza** anche con template malevoli o errati.

---

# Parte 2 — L'API

## 2.1 Principi dell'API

- **Funzioni pure e per lo più sincrone.** `tokenize`, `parse`, `validate`, `analyze`
  e perfino il core di esecuzione `run` non hanno effetti collaterali e sono
  **sincrone** (dipendono solo da testo + stato).
- **Asincronia confinata al driver.** Solo l'orchestratore che *interroga le
  capability* (`drive`/`seebo `) è asincrono. Il cuore resta puro.
- **Errori strutturati.** Ogni errore porta `code`, `message` e `position` (l'elenco
  normativo dei `code` è parte del contratto pubblico).
- **Contratti pubblici versionati.** Le strutture che attraversano il confine
  motore↔applicazione portano un numero di versione esplicito: l'**AST** (`astVersion`),
  lo **State** persistibile (`stateVersion`) e l'output di `analyze` (`analysisVersion`).
  Cambiarne la forma in modo incompatibile è una *breaking change* e impone un
  incremento di versione (con conseguente invalidazione delle cache che vi dipendono).

## 2.2 `createEngine(config)`

Costruisce un motore **configurato**: lega una volta sola tipi, funzioni, macro,
librerie, capability e politiche. Restituisce un oggetto con i metodi delle §2.3–2.6.

```js
import { createEngine, builtins } from 'seebo ';

const engine = createEngine({
  // Vocabolario del linguaggio
  types:     [ ...builtins.types ],     // int float bool string datetime duration object array
  functions: [ ...builtins.functions ], // produttori/trasformatori standard
  macros:    [ ...builtins.macros ],    // ABSORB MERGE REMOVE_* COLLAPSE
  libraries: ['fake'],                   // namespace opzionali (lazy-load)

  // Capability: l'INTERO set utilizzabile dai require è definito qui dall'applicazione.
  // Non esistono capability builtin (§1.6). Una capability è una funzione che, dato il
  // requirement, ne produce il valore (sync o Promise).
  capabilities: {
    user:     (req)  => /* valore raccolto dall'utente, o lasciato all'orchestratore */,
    crm:      (req)  => /* lookup su ERP → object */,
    secrets:  (req)  => /* string|undefined */,
    weather:  (req)  => /* await fetchMeteo(...) */,
  },

  // Politiche e ambiente
  policy: {
    allowedTypes: [...], allowedFunctions: [...], allowedCapabilities: [...],
    trustLevel: 'untrusted',        // livello di fiducia del template (es. 'trusted'|'untrusted')
    capabilityRules: {              // regole per-capability (autorizzazione)
      secrets: { allowFrom: 'trusted', audit: true },   // usabile solo da template fidati
      crm:     { audit: true },
    },
    redact: ['secrets'],            // i valori di queste capability sono mascherati nei log
  },
  locale:   'it-IT',
  clock:    () => new Date(),
  seed:     undefined,
  limits:   { maxDepth: 20, maxPhases: 10, maxOutputBytes: 1_000_000, timeoutMs: 2000 },

  // Delimitatori configurabili (§1.2)
  delimiters: { formula: '$', comment: '#', macro: '@', open: '{', close: '}' },

  // Ottimizzazioni opt-in (default tutte off)
  optimizations: { lazyParse: false, astCache: false, stream: false, objectPool: false },
});
```

> **Perché `createEngine`.** Senza, dovresti ripassare l'intero vocabolario a ogni
> chiamata. Legandolo una volta, i metodi sono già "consapevoli" di
> tipi/funzioni/macro/capability/policy. È anche il punto in cui si realizza
> l'**inversione delle dipendenze**: il motore non sa *da dove* vengano i dati, lo
> dicono le `capabilities`.
>
> **Sicurezza delle capability.** Poiché una capability può toccare segreti, ERP o
> sistemi esterni, la `policy` è il punto in cui l'applicazione governa *chi* può usare
> *cosa*: `allowedCapabilities` limita le capability invocabili; `capabilityRules`
> aggiunge regole per-capability (es. `allowFrom: 'trusted'` consente `secrets` solo a
> template con `trustLevel` fidato, `audit: true` registra ogni invocazione); `redact`
> elenca le capability i cui valori vanno **mascherati** nei log e nelle diagnostiche.
> Una violazione di policy è un errore strutturato e ferma la risoluzione. Il *confine
> di fiducia* resta che il **backend è l'autorità** che ri-valida l'output definitivo.

## 2.3 Analisi statica: `tokenize`, `parse`, `validate`, `analyze`

Tutte **sincrone** e **pure** (dipendono solo da `template` + config).

### `engine.tokenize(template) → Token[]`
Lista **piatta** di token con posizione e tipo. **Tollerante agli errori** (non
lancia): serve all'evidenziazione di sintassi nell'editor anche mentre si scrive.

```js
engine.tokenize("Ciao ${ nome.upper() }")
// → [{kind:'text'}, {kind:'slot-open'}, {kind:'name'}, {kind:'dot'},
//    {kind:'method'}, {kind:'paren'}, {kind:'paren'}, {kind:'slot-close'}]
```

### `engine.parse(template) → Document`
Costruisce l'**AST** (sequenza di nodi *testo* e *slot*; ogni slot-formula contiene
l'albero dell'espressione). **Lancia** un errore con posizione se la sintassi è
malformata.

```js
engine.parse("${ 1 + 2 * 3 }")
// → { nodes: [ { kind:'formula', expr:
//     { op:'+', left:{lit:1}, right:{ op:'*', left:{lit:2}, right:{lit:3} } } } ] }
```

### `engine.validate(template) → Diagnostic[]`
Diagnostiche statiche (vuota = ok): identificatori non dichiarati, funzioni/arità,
violazioni di tipo deducibili, capability non registrate, tipi non ammessi dalla
`policy`.

```js
engine.validate("${ nome }")
// → [{ code:'UNDECLARED_NAME', position:{...}, message:"'nome' non è dichiarato" }]
```

### `engine.analyze(template) → Analysis`
Descrive **cosa serve** per completare il documento, senza eseguirlo. Qui seebo  si
comporta quasi come un **compilatore**: non produce solo l'elenco dei requirement, ma
un piano completo. I requirement restituiti sono i descrittori dichiarati (§1.6),
**arricchiti** con campi *derivati* che non si scrivono a mano: `phase` (calcolata dal
grafo) e `options` (estratto da `type.constraints.values`, quando presente).

```ts
type Analysis = {
  analysisVersion: number;        // versione del contratto (vedi §2.1)
  ast: Document;                  // l'AST (contratto pubblico)
  requirements: RequirementDescriptor[];   // tutti i requirement dichiarati
  requirementGraph: Graph;        // archi A→B (B attivo solo in un ramo che dipende da A)
  executionPlan: Phase[];         // fasi: quali requirement diventano attivi e quando
  capabilitiesUsed: string[];     // es. ['user','crm']
  staticValues: Record<string,Value>;  // ciò che è già risolvibile a freddo (puro)
  deterministic: boolean;         // l'output dipende solo dagli input? (no now/fake liberi)
  streamability: 'full' | 'partial' | 'buffered';  // idoneità allo streaming (vedi sotto)
  potentialCycles: Cycle[];       // cicli di inclusione/dipendenza rilevati staticamente
  maxPhases: number;              // limite superiore al numero di giri di conversazione
  worstCaseRequirements: number;  // quanti requirement nel cammino peggiore
};
```

`streamability` classifica *staticamente* quanto il documento può essere emesso in
streaming (utile per decidere se usare l'output incrementale): **`full`** = ogni
prefisso diventa definitivo in ordine, si può emettere man mano; **`partial`** = lo
streaming è possibile fino a punti sicuri, poi va bufferizzato (es. una macro di layout
locale più avanti); **`buffered`** = il documento richiede l'output completo prima di
emettere (macro che riscrivono righe precedenti, o forte riordino). È accompagnata,
quando non è `full`, dalle diagnostiche che spiegano *cosa* impedisce lo streaming.

```js
engine.analyze(`
  ${ need({ id:'paese', capability:'user', label:'Paese',
              type: array().constraints({ values:['IT','US'] }) }) }
  ${ paese == 'IT'
       ? need({ id:'citta', capability:'user', label:'Città', type: string() })
       : '' }
`)
// → {
//   requirements: [
//     { id:'paese', type:'array', capability:'user', label:'Paese',
//       options:['IT','US'], optional:false, phase:1 },
//     { id:'citta', type:'string', capability:'user', label:'Città', phase:2 }
//   ],
//   requirementGraph: { edges: [ ['paese','citta'] ] },
//   executionPlan: [ {phase:1, requirements:['paese']}, {phase:2, requirements:['citta']} ],
//   capabilitiesUsed: ['user'],
//   staticValues: {}, deterministic: true, potentialCycles: [],
//   maxPhases: 2, worstCaseRequirements: 2
// }
```

> **A cosa serve la ricchezza di `analyze`.** Un editor può mostrare avvisi come
> *"questo template richiederà al massimo 7 passi di interazione"*, *"richiede la
> capability `crm`"*, oppure *"non può terminare: il grafo contiene un ciclo"* — il
> tutto **senza eseguire nulla** e senza dati reali.

## 2.4 Il modello di esecuzione: `start`, `run`, lo `State`

L'esecuzione è una **macchina a stati pura**. Il cuore è `run`, che riceve uno stato e
ne restituisce uno nuovo, **senza I/O**: si limita a valutare il più possibile e a
raccogliere i `Need` che non sa soddisfare.

```ts
type State = {                // lo "State pubblico": l'unica forma da serializzare
  stateVersion: number;       // versione del contratto (vedi §2.1)
  template: string;           // il SORGENTE del template: forma canonica e portabile
  resolved: Record<string, Value>;   // requirement già soddisfatti (per id)
  pending:  RequirementDescriptor[]; // Need emersi nell'ultima passata
  phase:    number;
  status:   'running' | 'waiting' | 'completed' | 'failed';
  output?:  string;           // presente quando status === 'completed'
  diagnostics?: Diagnostic[];
};

engine.start(template, initialValues?) → State        // stato iniziale (status:'running')
engine.run(state) → State                              // un passo: puro, sincrono
```

> **State pubblico vs forma interna.** Lo `State` qui definito è il **contratto
> pubblico serializzabile**: è ciò che SDK, persistenza (Redis/DB/file) e frontend
> devono salvare e ripristinare. La sua forma canonica porta il **sorgente** del
> template (`template: string`), non un AST né un hash: così lo stato è
> autosufficiente, portabile tra processi e versioni, e non dipende da una cache locale.
> Il motore *può* mantenere internamente una forma più ricca (es. un riferimento
> all'AST memoizzato) per efficienza, ma quella è una **forma interna non
> serializzata**: ricostruibile in O(parse) dal solo `template`, non fa parte del
> contratto. Chi implementa la persistenza serializza lo State pubblico e basta.

Semantica di `run`:

- valuta tutti i nodi i cui ingressi sono disponibili in `state.resolved`;
- ogni requirement non ancora risolto produce un **`Need`** che confluisce in
  `pending`; i requirement gated da condizioni non ancora decise **non** compaiono
  (emergeranno in una fase successiva);
- se `pending` è vuoto ⇒ `status: 'completed'` con `output`;
- se ci sono `Need` ⇒ `status: 'waiting'`;
- un errore fatale ⇒ `status: 'failed'` con `diagnostics`.

Il **driver** (qualsiasi codice host) chiude il ciclo soddisfacendo i `Need`:

```js
let state = engine.start(template, { /* eventuali valori iniziali */ });

while (state.status === 'waiting') {
  // soddisfa i Need come preferisci: utente, API, cache, DB, LLM…
  const nuovi = await soddisfa(state.pending);     // → Record<id, valore>
  state = engine.run({ ...state, resolved: { ...state.resolved, ...nuovi } });
}

if (state.status === 'completed') console.log(state.output);
```

> **Teoria — terminazione del ciclo.** L'insieme dei requirement *attivi* cresce in
> modo **monotòno** (un requirement attivato non si disattiva nello stesso ciclo) e
> l'universo dei requirement è **finito** ⇒ il ciclo raggiunge un **punto fisso** in un
> numero finito di passi (capato da `limits.maxPhases`). È il pendant pratico della
> totalità del linguaggio (§1.1, principio 3).
>
> **Perché lo stato è esterno (stateless engine).** Passando lo stato a ogni `run`, il
> motore resta **puro** e lo stato è **serializzabile**: lo si può salvare ovunque e
> riprendere altrove (anche in un altro processo). `run(state) → newState` è
> deliberatamente *funzionale*: niente `engine.resume(...)` con stato nascosto.

## 2.5 Capability automatiche e orchestrazione: `drive`, `expand`, `finalize`, `seebo `

Il ciclo di §2.4 è esplicito di proposito, ma spesso molti `Need` si soddisfano da
soli (un `crm`, un `secrets`): non serve coinvolgere l'utente. Il **driver** lo fa
automaticamente.

```js
// Soddisfa con le capability registrate tutti i Need che esse coprono;
// si ferma (status 'waiting') solo sui Need che vanno raccolti "fuori"
// (es. capability 'user'), restituendoli al chiamante.
const state = await engine.drive(stateOrTemplate, { stopOn: ['user'] });
```

Le macro vivono in fasi separate dalla risoluzione delle formule (§1.8). L'API le
espone sia singolarmente sia tramite una convenience:

```js
// (a) pre-pass: espande gli aggregatori (ABSORB/MERGE) usando i template forniti
const composed = await engine.expand({ template, templates });

// (b) esecuzione multi-fase (driver) su `composed`  → §2.4

// (c) post-pass: applica le macro di layout/rimozione (REMOVE_*/COLLAPSE)
const output = engine.finalize(resolvedText);

// Convenience: incatena (a) → (b) → (c), gestendo la conversazione.
const res = await engine.seebo ({ template, templates, values });
```

> **Perché fasi separate e in quest'ordine.** *Comporre → riempire → ripulire* è
> l'ordine naturale: prima si assembla il documento completo (gli aggregatori possono
> introdurre nuove formule e nuovi requirement), poi si riempiono le formule (la
> conversazione vede *tutti* i requirement, anche quelli importati), infine si
> rifinisce il layout sul testo ormai risolto.

## 2.6 Estensibilità: `defineType`, `defineFunction`, `defineMacro`, `defineCapability`, `defineLibrary`

Aggiungono **vocabolario** senza modificare il core (Open/Closed). Si passano poi a
`createEngine`.

```js
// Un nuovo tipo di dato (esempio: 'money')
const Money = defineType('money', {
  category: 'base',
  defaultFormat: { currency: 'EUR', decimalSep: ',' },
  validate:  (v, c) => /* … */,
  stringify: (v, fmt) => /* … */,
});

// Una nuova funzione (produttore o trasformatore)
const Slugify = defineFunction('slugify', {
  receiver: 'string',                 // metodo su string (omesso ⇒ produttore)
  arity: { min: 0, max: 0 },
  eval: (self) => self.toLowerCase().replace(/\s+/g, '-'),
});

// Una nuova macro (aggregatore o layout)
const Banner = defineMacro('BANNER', { phase: 'finalize', apply: (slot, doc) => /* … */ });

// Una nuova capability: il template userà need({ capability:'weather', … })
const Weather = defineCapability('weather', {
  resolve: async (req) => fetchOpenMeteo(req.location),   // può essere async
});

// Una libreria/namespace (es. un set di generatori)
const Geo = defineLibrary('geo', { /* funzioni del namespace geo.* */ });
```

> **Nomi.** Il nome scelto per un tipo/funzione/macro/libreria/capability deve
> rispettare le **parole riservate** e l'unicità nello spazio dei nomi (§1.5).
> `createEngine` **fallisce** se due definizioni collidono o se un nome è riservato.
> Per le capability vale in più lo zucchero "capability come produttore" (§1.6): il
> nome diventa direttamente invocabile come `nome({ … })`.

## 2.7 Esempio end-to-end

```js
const engine = createEngine({
  ...builtins.all,
  // L'app dichiara qui l'intero set di capability. Nessuna è builtin.
  capabilities: {
    secrets: (req) => ({ mittente: 'noreply@acme.io' })[req.id],
    crm:     (req) => ({ ordine: { id: 42, totale: 1234.5, data: '2026-06-20T10:00:00Z' } })[req.id],
    user:    (req) => undefined,   // interattiva: i suoi Need tornano all'orchestratore
  },
  locale: 'it-IT',
});

// Si usano le capability come produttori (zucchero per require, §1.6):
// secrets({…}), crm({…}), user({…}).
const template = `
#{ Intestazione email d'ordine }
Da: ${ secrets({ id:'mittente', type:string() }) }
Oggetto: Ordine ${ crm({ id:'ordine', type:object() }).id } — ${ float(ordine.totale).constraints({precision:2}) } €
Evaso ${ (now() - datetime(ordine.data)).totalDays().round() } giorni fa.
${ user({ id:'saluto', label:'Saluto',
          type: array().constraints({values:['Gentile','Ciao']}) }) } cliente,
${ user({ id:'note', label:'Note aggiuntive?', type: string(), optional:true }) != ''
     ? 'Note: ' + note : '@{REMOVE_LINE}' }
`;

// 1) Cosa serve?  → genera il form e il piano
engine.analyze(template);
// requirements: saluto (lista user), note (string user, opzionale);
// capabilitiesUsed: ['secrets','crm','user']; maxPhases: 1

// 2) Esegui (driver): secrets/crm si risolvono da soli; i Need 'user' arrivano da `values`
const res = await engine.seebo ({
  template,
  values: { saluto: 'Gentile', note: '' },
});
// res.status === 'completed'
// res.output:
//   Da: noreply@acme.io
//   Oggetto: Ordine 42 — 1234,50 €
//   Evaso 6 giorni fa.
//   Gentile cliente,
//   (la riga "Note" è stata rimossa perché note era vuota)
```
