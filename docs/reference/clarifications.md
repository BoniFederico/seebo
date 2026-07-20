# Decisioni normative v1 JavaScript

2. **steboStream / SeeboStream e `optimizations.stream`**

   Per la v1 non implementare lo streaming.

   Lo streaming è una ottimizzazione `stream` opt-in e avanzata.

   Non esporre `engine.steboStream()` nella public API della v1, oppure lascialo assente.

   Quando verrà implementato, il nome corretto dovrà essere `steboStream`, non `SeeboStream`.

   `optimizations.stream` deve restare accettato nella config, con default `false`, ma senza effetto operativo nella v1.

3. **Scope v1 e ottimizzazioni**

   La v1 implementa la strategia di ripresa 1: re-evaluation completa a ogni `run`.

   Tutte le ottimizzazioni sono off di default:

   ```js
   optimizations: {
     lazyParse: false,
     astCache: false,
     stream: false,
     objectPool: false
   }
   ```

   Non implementare nella v1:

   - `lazyParse`
   - `objectPool`
   - `astCache` persistente
   - `stream`

   Mantieni la config compatibile.

   La v1 deve includere le façade:

   - `stebo`
   - `start`
   - `run`
   - `drive`
   - `expand`
   - `finalize`
   - `tokenize`
   - `parse`
   - `validate`
   - `analyze`
   - analisi statica completa

   Il core deve essere puro e sincrono.

   L’asincronia è ammessa solo in `drive` e `stebo`.

4. **Libreria `fake.*`**

   Non implementare dipendenza esterna `@faker-js/faker`.

   Implementa il meccanismo namespace/libreria tramite `defineLibrary`.

   Lascia `fake` come esempio, documentazione o fixture minimale nei test.

   Se serve nei test, usa una fake library interna minimale e deterministica, senza dipendenze esterne.

5. **`date(pattern, testo)` e pattern datetime**

   Usa un mini parser/formatter interno.

   Non usare `date-fns`, `dayjs` o librerie equivalenti.

   Supporta il subset normativo di token datetime:

   | Token | Significato |
   |-------|-------------|
   | `YYYY` | Anno a 4 cifre |
   | `MM` | Mese `01-12` |
   | `DD` | Giorno `01-31` |
   | `HH` | Ora `00-23` |
   | `mm` | Minuti `00-59` |
   | `ss` | Secondi `00-59` |
   | `Z` | Timezone UTC, letterale `Z` |

   Pattern minimo obbligatorio:

   ```txt
   YYYY-MM-DDTHH:mm:ssZ
   ```

   Non supportare nella v1:

   - timezone arbitrarie
   - nomi mese
   - localizzazione testuale
   - millisecondi
   - offset come `+02:00`

   Internamente `datetime` è rappresentato come epoch UTC in millisecondi + precisione.

   Pattern non supportato deve produrre un diagnostic strutturato.

6. **Policy enforcement, retry, audit e redact**

   La policy deve essere semplice e deterministica.

   La struttura policy include:

   ```js
   policy: {
     allowedTypes,
     allowedFunctions,
     allowedCapabilities,
     redact,
     audit,
     retry
   }
   ```

   `retry` default:

   ```js
   retry: {
     attempts: 0,
     backoffMs: 0
   }
   ```

   Nessun retry automatico nella v1.

   `audit` è un hook configurabile:

   ```js
   audit(event) {}
   ```

   Default: noop.

   Il core non deve mai scrivere su `console`.

   `redact` è un hook configurabile:

   ```js
   redact(value, context) {
     return value;
   }
   ```

   Default: identità.

   Timeout e limiti restano in `limits`:

   ```js
   limits: {
     maxDepth,
     maxPhases,
     maxOutputBytes,
     timeoutMs
   }
   ```

7. **`object` / `array` come `Value` interno**

   Ogni valore Stebo è un record immutabile:

   ```js
   {
     type,
     value,
     format,
     constraints
   }
   ```

   Per `object` e `array`, `value` può contenere plain JSON JavaScript per semplicità, leggibilità e performance.

   Accessi come:

   - `o.get('k')`
   - `o.campo`
   - `a.get(0)`

   convertono al volo in `Value` tipato Stebo.

   Inferenza v1:

   | Input JavaScript | Tipo Stebo |
   |------------------|------------|
   | number intero sicuro | `int` |
   | number non intero | `float` |
   | boolean | `bool` |
   | string | `string` |
   | Array | `array` |
   | plain object | `object` |
   | `null` / `undefined` | errore o valore vuoto solo dove esplicitamente previsto |
   | `Date` JS | `datetime` solo se prodotto internamente |

   Non inferire `datetime` da stringhe ISO in `object` / `array`.

   Non implementare coercizioni magiche.

8. **Builder immutabili `string()`, `int()`, `array()`, ecc.**

   Confermata API fluente e immutabile.

   Esempio:

   ```js
   string()
     .constraints({ minLen: 1 })
     .format({ /* ... */ })
     .default('x')
   ```

   `format()` e `constraints()` ritornano nuovi oggetti senza mutazione.

   Doppia semantica v1:

   | Chiamata | Significato |
   |----------|-------------|
   | `int()` | builder |
   | `int(123)` | `Value` int |
   | `string()` | builder |
   | `string('x')` | `Value` string |
   | `array()` | builder |
   | `array([1])` | `Value` array |

   Usare JSDoc per distinguere builder e producer.

9. **`tokenize` kind mapping: `name` vs `method`**

   Il lexer deve usare una distinzione contestuale leggera.

   Un identificatore immediatamente preceduto da `.` nello stesso slot è `method`.

   Altrimenti è `name`, salvo keyword, literal e operatori.

   Non fare risoluzione semantica profonda nel lexer.

   La distinzione serve per editor e syntax highlighting.

   Il parser è responsabile della struttura AST effettiva.

10. **`stebo` con capability user e precedenza `values`**

   I `values` passati a:

   ```js
   stebo({ template, values })
   ```

   pre-popolano `state.resolved`.

   Precedenza:

   1. `values` iniziali
   2. `state.resolved`
   3. `run`
   4. `pending Need` solo per ciò che manca davvero
   5. `drive` prova capability non bloccate
   6. capability che restituisce `undefined` = `Unresolved`

   `undefined` non è un valore valido.

   Per capability `user`, è consigliato fermarsi e restituire `Need` tramite:

   ```js
   stopOn: ['user']
   ```

   Nella convenience `stebo`, se `values` contiene già i requirement `user`, quei `Need` non devono comparire.

11. **Versioni iniziali**

   Parti da:

   ```js
   astVersion = 1
   stateVersion = 1
   analysisVersion = 1
   ```

   AST e State sono contratti pubblici versionati.

   L’AST porta `astVersion`.

   I migratori v1 sono vuoti:

   ```js
   migrations: []
   ```

   Aggiungere una struttura minima per future migration.

12. **Sezione §14 mancante in `IMPL.md`**

   Trattala come refuso di numerazione.

   Non assumere contenuti mancanti.

   Non inventare una sezione §14.

   Segnala il refuso in `docs/KNOWN_ISSUES.md` o in un commento di progetto.

13. **Istruzione finale per l’LLM**

   Implementa in JavaScript moderno, non TypeScript.

   Usa JSDoc completo per documentare:

   - contratti pubblici
   - parametri
   - ritorni
   - errori
   - strutture dati

   Priorità:

   1. organizzazione pulita
   2. leggibilità
   3. manutenibilità
   4. testabilità
   5. performance/efficienza senza sacrificare chiarezza

   Non implementare ottimizzazioni avanzate nella v1.

   Non introdurre dipendenze esterne se non strettamente necessarie.

   Se una parte non è normata, implementa comportamento minimo, puro, deterministico e documentato, oppure apri un TODO esplicito senza inventare feature.