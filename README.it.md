# HealthBridge

Un'app per iPhone e un piccolo Cloudflare Worker che trasformano i tuoi dati di Salute in un riepilogo privato, sempre aggiornato, leggibile da qualsiasi assistente AI in grado di aprire un URL. Niente abbonamenti, niente app di terze parti, niente server da gestire a casa: i piani gratuiti di Cloudflare Workers e D1 bastano per una persona.

[Read in English](README.md)

```
Apple Watch / iPhone → Salute → app HealthBridge → Cloudflare Worker + D1 → link privato → il tuo coach AI
```

## Cosa fa

- **Caricamento automatico.** L'app registra osservatori HealthKit: iOS la sveglia quando arrivano nuovi dati (sonno e allenamenti subito, dati frequenti come la frequenza cardiaca al massimo una volta all'ora) e invia solo le novità. Sincronizza anche a ogni apertura e chiede a iOS un aggiornamento in background ogni 30 minuti.
- **Quasi tutto ciò che c'è in Salute.** Allenamenti con statistiche, giri, segmenti, metadati e percorsi GPS di Apple; frequenza cardiaca, HRV, FC a riposo, VO2 max, fasi del sonno, respirazione, ossigeno, temperatura al polso; metriche di corsa, nuoto, ciclismo e immersioni; misurazioni corporee, nutrizione, acqua, caffeina, sintomi, umore (Stato d'animo), avvisi Apple Watch, classificazione ECG, integratori e farmaci (dose presa o saltata). Restano fuori solo ciclo mestruale, attività sessuale, sedia a rotelle e dati sull'insulina.
- **Un riepilogo privato per il tuo coach.** `/link/<SHARE_TOKEN>` restituisce una pagina in testo semplice: gli ultimi 14 giorni giorno per giorno, medie confrontate con il periodo precedente, ogni allenamento con la frequenza cardiaca delle due metà, parziali al km, dislivello, passo ai 100 m e SWOLF nel nuoto, sonno, integratori, umore, storico a lungo termine e i tuoi spazi liberi in Calendario. La prima riga indica quando la pagina è stata generata, al secondo.
- **Grafici ed esportazioni.** `/data/<SHARE_TOKEN>/` è una pagina web con grafici (30 giorni, 90 giorni, un anno, tutto per mese) e gli ultimi 40 allenamenti, più `daily.csv`, `workouts.csv`, un file GPX per ogni allenamento all'aperto, due calendari sottoscrivibili (`workouts.ics`, `sleep.ics`) e `latest.json` per Home Assistant.
- **Automazioni.** Pacchetti di dati con un nome, composti da 13 categorie (sonno, cuore, allenamenti, nutrizione...), ognuno un link privato a sé stante o un webhook POST ogni 1-24 ore inviato dal cron del Worker, così funziona anche con il telefono bloccato.
- **Pianificazione del calendario.** Con accesso completo al calendario l'app invia i tuoi impegni per i successivi 14 giorni (solo inizio e fine, mai i titoli), così il coach può pianificare allenamenti negli spazi liberi. Il coach chiude un piano con un blocco `PLAN` ... `END`; l'app lo importa in un calendario "Workouts" e verifica poi quali sessioni pianificate hai effettivamente svolto.
- **Diario di allenamento.** Gli esercizi del piano diventano una sessione che registri serie per serie (ripetizioni o secondi, peso, timer recupero, "volta scorsa" per ogni esercizio), con un'Attività Live sulla schermata di blocco i cui pulsanti funzionano senza sbloccare. Le sessioni vanno al server e il coach le vede.
- **Contatore acqua.** Registri i bicchieri dall'app, da un widget sulla schermata Home con pulsanti, da un controllo in Centro di Controllo o dall'azione Comandi Rapidi; ogni bicchiere viene scritto in Salute. Storico 60 giorni, giorni passati modificabili, obiettivo giornaliero visibile al coach.
- **Widget di stato.** Widget piccolo, medio e per schermata di blocco che mostrano se i dati arrivano, quando il coach ha letto i dati l'ultima volta, e sonno, FC a riposo, HRV e passi di oggi.
- **Briefing mattutino (opzionale).** L'app può inviare la tua posizione arrotondata, eventi imminenti con titoli, compleanni da Contatti e una lista di Promemoria a un tuo servizio di briefing (per esempio un bot che ti messaggia ogni mattina). Vedi [Briefing mattutino](#briefing-mattutino-opzionale).

## Architettura

| Componente | Dove | Cosa fa |
|---|---|---|
| App iOS | `HealthBridge/` | Osservatori e query ancorate HealthKit, caricamento a batch di 2.000, calendario, acqua, diario allenamenti, schermata automazioni, feed briefing |
| Estensione widget | `HealthBridgeWidget/` | Widget stato, widget e controllo acqua, Attività Live allenamento |
| Codice condiviso | `Shared/` | Compilato in entrambi i target: stato server, coda acqua (App Group), intent Attività Live, `Secrets.swift` generato |
| Worker | `server/src/` | Ingest, riepilogo, pagina grafici, esportazioni, automazioni, manutenzione notturna. Dettagli in [server/README.md](server/README.md) |
| Database | Cloudflare D1 | Campioni grezzi (quelli frequenti tenuti 90 giorni), storico giornaliero permanente, allenamenti per sempre, registro letture |

Come funziona il caricamento:

1. Un `HKObserverQuery` per tipo di dato con consegna in background. Quando arrivano nuovi dati iOS sveglia l'app, anche se è chiusa.
2. Un `HKAnchoredObjectQuery` per tipo restituisce solo campioni nuovi ed eliminati dall'ultimo caricamento. L'ancora viene salvata solo dopo che il server risponde OK: se il caricamento fallisce, i dati attendono il giro successivo.
3. Al massimo ogni 30 minuti l'app invia anche i totali giornalieri degli ultimi 3 giorni (passi, energia, distanza, esercizio...) calcolati da HealthKit, che rimuove i duplicati tra iPhone e Watch.
4. Ogni notte alle 03:30 UTC il Worker calcola i valori giornalieri (FC a riposo, HRV, sonno, VO2 max, peso...) nella tabella permanente `daily` ed elimina i campioni frequenti più vecchi di 90 giorni. Il database cresce di pochi MB all'anno.

Alla prima sincronizzazione l'app invia gli ultimi 14 giorni. La sezione storico si riempie da quel momento in poi.

## Requisiti

- Un iPhone con iOS 27 o successivo (il minimo è dettato da HRV RMSSD e dall'API Farmaci), idealmente con Apple Watch.
- Un Mac con Xcode 27 e un Apple ID. Un account gratuito va bene: la consegna in background è inclusa nel profilo gratuito, ma l'app va rifirmata ogni 7 giorni (vedi [Mantenere l'app installata](#mantenere-lapp-installata)).
- Un account Cloudflare gratuito e una Node.js LTS attuale (per `wrangler`).

## Configurazione da zero

### 1. Server (Cloudflare Worker + D1)

Dalla cartella `server/`:

```sh
npm install
npx wrangler login
npx wrangler d1 create health-bridge-db --jurisdiction eu   # rimuovi --jurisdiction per scegliere qualsiasi regione
```

Incolla il `database_id` stampato in `server/wrangler.jsonc`, poi:

```sh
npm run db:remote                      # applica le migrazioni
cp .secrets.example .secrets           # inserisci tre token: openssl rand -hex 16
npx wrangler secret put INGEST_TOKEN   # incolla gli stessi valori di .secrets
npx wrangler secret put READ_TOKEN
npx wrangler secret put SHARE_TOKEN
npm run deploy
```

Metti l'indirizzo del Worker stampato da `deploy` (per esempio `https://health-bridge.<your-subdomain>.workers.dev`) in `SERVER_URL` dentro `.secrets`.

Il server conta i giorni nel fuso orario `Europe/Rome`. Se vivi altrove, cambia `TIME_ZONE` e la funzione di offset rapido in `server/src/time.ts` (implementa la regola dell'ora legale centroeuropea).

### 2. App (Xcode)

1. Cambia gli identificatori da `com.example.healthbridge` al tuo dominio inverso, ovunque contemporaneamente:

   ```sh
   grep -rl com.example.healthbridge --include='*.pbxproj' --include='*.plist' --include='*.entitlements' --include='*.swift' --include='*.sh' . \
     | xargs sed -i '' 's/com\.example\.healthbridge/com.yourname.healthbridge/g'
   ```

   Questo copre i bundle ID dell'app e del widget, l'App Group (`group.com.yourname.healthbridge`) e l'ID dell'attività in background.
2. Genera il file dei segreti che l'app compila: `scripts/make-secrets.sh` (legge `server/.secrets` e scrive `Shared/Secrets.swift`, ignorato da git).
3. Apri `HealthBridge.xcodeproj`, seleziona entrambi i target (HealthBridge e HealthBridgeWidgetExtension), Signing & Capabilities, e scegli il tuo team. Xcode crea l'App Group la prima volta.
4. Collega l'iPhone e premi Run.
5. Con un account gratuito: sull'iPhone, Impostazioni, Generali, VPN e gestione dispositivi, il tuo Apple ID, Autorizza.
6. Nell'app tocca **Sync now** e concedi l'accesso a tutti i tipi di dati. Poi **Choose supplements and medications** se li tracci in Salute, e **Connect the calendar** se vuoi la pianificazione.

Il simulatore non carica mai nulla (`#if targetEnvironment(simulator)`), quindi una sessione di prova non può finire nei tuoi dati reali.

### 3. Verifica che funzioni

- Nell'app: la riga di stato dice "All good" con l'ora dell'ultimo caricamento.
- `curl -H "Authorization: Bearer $READ_TOKEN" $SERVER_URL/status` restituisce l'ultimo caricamento e gli ultimi valori.
- Apri `$SERVER_URL/link/$SHARE_TOKEN` in un browser: è esattamente ciò che legge il coach.

## Utilizzo del link con un assistente AI

Il link è pensato per un assistente che può aprire pagine web, configurato una volta in un progetto o nelle istruzioni di un assistente personalizzato, così ogni conversazione parte con dati freschi e non incolli mai nulla.

1. Copia il tuo link: `$SERVER_URL/link/$SHARE_TOKEN` (14 giorni di default; `/summary?days=N` con il token di lettura va da 1 a 31).
2. Mettilo nelle istruzioni di un progetto, con qualche riga come il modello in [docs/assistant-instructions.md](docs/assistant-instructions.md): apri il link prima di ogni risposta, usa solo quei numeri, segnala quando mancano dati.
3. Fai le tue domande. L'app mostra "Last read by the coach" così sai se l'assistente ha davvero aperto il link.

Cosa è stato testato (ChatGPT, ottobre 2026):

- ChatGPT apre il link dalle istruzioni di un progetto, con user agent `ChatGPT-User/1.0`. Il server registra ogni lettura con il suo user agent; "Last read by the coach" conta solo quello, perché incollare un link in una chat attiva anche i fetch di anteprima.
- Mantieni il link breve e senza `?`: un link più lungo con query string falliva con "Invalid URL" prima di raggiungere il server.
- Lo strumento web di ChatGPT mostra la copia salvata alla visita *precedente* e scarica la nuova per la volta dopo. Il modello chiede quindi all'assistente di aprire il link due volte e usare la seconda copia, e la pagina indica quando è stata generata. Iniziare una nuova chat ogni giorno aiuta.
- Altri assistenti non sono stati testati: qualsiasi strumento che possa recuperare un URL dovrebbe funzionare allo stesso modo. Per i programmi, `?format=json` su `/summary` restituisce gli stessi dati come JSON.

Chiunque abbia il link può leggere il riepilogo. Tienilo solo nelle istruzioni dell'assistente; se finisce altrove, cambia `SHARE_TOKEN` (vedi il [README del server](server/README.md)).

## Funzionalità in dettaglio

### Grafici, esportazioni e widget

Tutto dietro il token di condivisione, all'indirizzo `$SERVER_URL/data/<SHARE_TOKEN>/` (nell'app: **Charts & exports**):

- **Grafici:** sonno con fasi, FC a riposo, HRV, passi, energia, esercizio, VO2 max, peso, respirazione, luce solare, acqua; più gli ultimi 40 allenamenti.
- **CSV:** `daily.csv` (un giorno per riga) e `workouts.csv`.
- **GPX:** `gpx/<workout uuid>`, collegato dalla tabella degli allenamenti.
- **Calendari:** `workouts.ics` (ultimi 2 anni) e `sleep.ics` (ultime 90 notti). Tocca il link sull'iPhone e conferma l'iscrizione.
- **Home Assistant:** `latest.json` con gli ultimi valori, piatti. La pagina include un esempio di sensore `rest:` pronto all'uso.
- **Widget:** tieni premuta la schermata Home, Modifica, Aggiungi widget, HealthBridge. Diventa verde quando l'ultimo caricamento è meno di 3 ore fa.

### Automazioni

Nell'app: **Automations**, **+**, con tre preset (Salute, Sport, Altro). Ogni automazione ha:

- **categorie:** una o più delle 13 in `server/src/categories.ts`;
- **periodo:** oggi, 7, 14 o 31 giorni;
- **formato:** testo (per assistenti) o JSON (per programmi e Home Assistant);
- **destinazione:** un link privato `/a/<token>` (l'app copia il link e le istruzioni pronte), oppure un webhook: una POST a un indirizzo `https://` ogni 1, 3, 6, 12 o 24 ore, con un header opzionale per il token.

Il Worker invia i webhook dal suo cron orario, non dal telefono, quindi partono anche con il telefono bloccato. Ogni automazione mantiene un registro di letture o consegne. Una pagina filtrata avvisa che gli altri dati non sono inclusi, così l'assistente non li scambia per dati mancanti. Il link principale contiene sempre tutto.

### Calendario e piano del coach

- **Lettura:** con accesso completo (**Connect the calendar**), al massimo ogni 15 minuti l'app invia gli eventi di tutti i calendari per i successivi 14 giorni: solo inizio e fine, mai i titoli. Compleanni, eventi segnati come liberi, inviti rifiutati ed eventi di tutto il giorno non segnati come occupati vengono esclusi.
- **Nella pagina:** per ogni giorno, fasce occupate, slot liberi di almeno 45 minuti tra le 06:30 e le 22:00, e allenamenti pianificati; per gli ultimi 14 giorni, quali allenamenti pianificati sono stati svolti (un allenamento lo stesso giorno entro 3 ore).
- **Scrittura:** il coach chiude ogni piano con un blocco come questo:

  ```
  PLAN
  2026-10-15 18:30 | 60 | Lower body strength | notes
  > Squat | 4x8 | 60 kg | 120 s
  > Plank | 3x45 s | bodyweight | 60 s
  END
  ```

  Una riga per sessione (`data ora | minuti | titolo | note`), e sotto una riga per esercizio che inizia con `>` (`nome | serie x ripetizioni | peso | recupero | note`; anche `4xmax`, `3x45 s`). Copialo, poi **Import the coach's plan**, Incolla: l'app mostra un'anteprima, crea gli eventi in un calendario "Workouts" (su iCloud se disponibile) e carica gli esercizi nella sezione allenamento. Un nuovo piano sostituisce gli allenamenti pianificati dal suo primo giorno in poi. Le righe fuori formato vengono ignorate, così puoi incollare tutta la risposta.

### Diario allenamenti

- Dalla prossima sessione pianificata (o un allenamento libero) registri serie per serie. Ripetizioni o secondi e peso sono precompilati (l'ultima serie fatta, altrimenti il piano, altrimenti l'ultima volta) e cambiano con + e −. **Set done** avvia il timer di recupero del piano (90 secondi se non specificato).
- **Last time** mostra le serie dell'ultima sessione con lo stesso esercizio (stesso nome, ignorando maiuscole e spazi).
- Durante una sessione un'Attività Live mostra esercizio, serie, valori suggeriti, recupero e ultima volta, con + e −, pulsanti **Set done** e **Next** che funzionano sulla schermata di blocco (`TrainingActionIntent` in `Shared/TrainingActivity.swift`, eseguito nel processo dell'app).
- I dati restano sul telefono in `training.json` (Application Support). Dopo ogni modifica l'app invia le ultime 60 sessioni a `POST /training`; il coach vede ogni serie e il peso migliore per ogni esercizio.
- L'Apple Watch continua a registrare l'allenamento (frequenza cardiaca, calorie): HealthBridge non scrive mai allenamenti in Salute, per evitare duplicati.

### Acqua

- **Water today** nell'app: +250 o +500 ml, Annulla per l'ultimo bicchiere, obiettivo giornaliero (2,5 L di default). Il widget **Water** (schermata Home con pulsanti, schermata di blocco con progresso), il controllo **Log water** in Centro di Controllo e l'azione Comandi Rapidi registrano senza aprire l'app.
- Ogni bicchiere viene scritto in Salute come `dietaryWater`, l'unico dato che HealthBridge scrive. Se Salute rifiuta (telefono bloccato, permesso non ancora concesso) il bicchiere resta in coda nell'App Group e l'app lo scrive dopo con l'orario giusto (`Shared/Water.swift`).
- **Cronologia:** ultimi 60 giorni con totale, bicchieri e obiettivo raggiunto; ogni giorno si apre per aggiungere bicchieri a posteriori o cancellarli (solo quelli scritti da HealthBridge). Dopo una correzione l'app reinvia i totali giornalieri da quel giorno, così il coach vede anche il giorno corretto.

### Integratori e farmaci

1. In Salute, Sfoglia, Farmaci, aggiungi ogni integratore o farmaco con la sua programmazione.
2. Nell'app, **Choose supplements and medications** e attiva quelli da condividere. Quando ne aggiungi uno nuovo, è Salute stessa a chiedere se condividerlo con HealthBridge.
3. Registra le dosi dalla notifica di Salute. Il riepilogo conta dosi prese, saltate e non registrate per ognuno, e `/summary?format=json` le elenca una a una (`extras.doses`).

### Briefing mattutino (opzionale)

HealthBridge può alimentare un servizio di briefing mattutino che gestisci tu (per esempio un Worker che ti manda un messaggio con meteo, agenda e sonno). L'app invia solo ciò che l'iPhone conosce; il briefing può leggere sonno e acqua da `/summary?format=json` con il token di lettura o un binding di servizio. I dati del briefing non vanno mai al server salute o al coach.

Imposta `BRIEFING_URL` e `BRIEFING_TOKEN` in `server/.secrets`, esegui `scripts/make-secrets.sh` e ricompila. Ogni richiesta è una `POST` JSON con `Authorization: Bearer <BRIEFING_TOKEN>` e deve rispondere `200`:

| Percorso | Quando | Corpo |
|---|---|---|
| `/location` | quando ti sposti (cambiamenti significativi di posizione iOS, serve accesso Sempre) e a ogni avvio, al massimo ogni 30 minuti a meno che tu non ti sia spostato di 1 km | `{ latitude, longitude, name, at }`, coordinate arrotondate a 0,01° (circa 1 km), `name` è la città |
| `/agenda` | a ogni avvio, e nelle sincronizzazioni in background al massimo ogni 15 minuti, prima dei dati salute | `{ lists, allLists, calendars, events, reminders }`: eventi di tutti i calendari per i prossimi 7 giorni con titoli, compleanni da Contatti, promemoria aperti delle liste volute, i nomi di tutte le liste. Rispondi `{ "lists": ["..."] }` per scegliere quali liste Promemoria l'app invierà la prossima volta |
| `/wake` | dall'azione Comandi Rapidi **Update the briefing** | `{}`, inviato dopo i dati salute, agenda e promemoria, così il briefing può partire appena ti svegli |

Nell'app: Salute, **Morning briefing**, **Connect location** e **Connect Reminders**. Senza token l'app non manda niente e la sezione dice che manca il token. Un fallimento qui non blocca mai il caricamento salute. Codice in `HealthBridge/Briefing/`.

## Mantenere l'app installata

Con un Apple ID gratuito la firma dura 7 giorni. `scripts/renew.sh` elimina i vecchi profili di provisioning, ricompila con `-allowProvisioningUpdates` e reinstalla via Wi-Fi; dati e impostazioni restano.

```sh
DEVICE_ID=<id from: xcrun devicectl list devices> scripts/renew.sh --force
```

Senza `--force` rinnova solo dopo 5 giorni, così puoi eseguirlo ogni poche ore da un LaunchAgent. Notifica sul Mac dal sesto giorno se fallisce, e indica la causa (Mac bloccato, iPhone non raggiungibile, Xcode senza account, compilazione fallita). L'ultimo output della compilazione è in `~/Library/Application Support/HealthBridge/last-build.log`. Serve che il Mac sia sveglio ogni tanto, l'iPhone sulla stessa rete e il tuo Apple ID ancora in Xcode, Settings, Accounts (un aggiornamento di Xcode può rimuoverlo). Non eseguirlo con lo schermo del Mac bloccato: macOS chiude il portachiavi e Xcode può perdere l'account.

Con un account sviluppatore a pagamento nulla di tutto questo serve.

## Privacy

- I tuoi dati vanno dal telefono al tuo account Cloudflare e da nessun'altra parte. Niente analisi, niente SDK di terze parti, nessun account da creare.
- Il database D1 può essere creato con `--jurisdiction eu` per tenerlo nell'Unione Europea.
- Quattro segreti: `INGEST_TOKEN` (scrittura), `READ_TOKEN` (lettura, usato da app e widget), `SHARE_TOKEN` (il link del coach e la pagina grafici, nell'URL) e l'opzionale `BRIEFING_TOKEN`. Risiedono in `server/.secrets`, nei segreti del Worker e nel generato `Shared/Secrets.swift`, tutti ignorati da git.
- Chi ha il link di condivisione può leggere il tuo riepilogo. Trattalo come una password. Il provider AI a cui lo dai leggerà i tuoi dati salute: controlla la sua policy sui dati.
- I titoli del Calendario non arrivano mai al server o al coach, solo ora di inizio e fine. Titoli, posizione e promemoria vanno solo al servizio briefing che configuri, se ne configuri uno.
- Ogni lettura del riepilogo è registrata con il suo user agent (`summary_reads`), così vedi chi ha aperto il link.
- Esporta tutto in qualsiasi momento: `npx wrangler d1 export health-bridge-db --remote --output backup.sql`.

## Risoluzione dei problemi

- **L'app non si apre più:** la firma a 7 giorni è scaduta. Esegui `scripts/renew.sh --force` con l'iPhone sulla stessa rete.
- **"Signing requires a development team":** scegli il tuo team in entrambi i target e verifica che il tuo Apple ID sia in Xcode, Settings, Accounts.
- **Errori server 401 o 503:** vedi il [README del server](server/README.md).
- **"Phone locked" come ultimo errore:** normale se l'ultimo caricamento riuscito è recente. iOS cifra i dati Salute mentre il telefono è bloccato; il giro successivo recupera.
- **Un tipo di dati negato per errore:** Salute, il tuo profilo, App, HealthBridge, riabilitalo.
- **Il widget dice che il server è irraggiungibile:** niente rete, o il token di lettura è cambiato (esegui `scripts/make-secrets.sh` e reinstalla).

## Struttura del progetto

- `HealthBridge/SyncEngine.swift`: observer, query ancorate, caricamento.
- `HealthBridge/ContentView.swift`: schermata principale, stato caricamento, ultima lettura del coach, pulsanti di configurazione.
- `HealthBridge/SummaryView.swift`: "Cosa vede il coach", il riepilogo scaricato dal server.
- `HealthBridge/AutomationsView.swift`: lista automazioni ed editor.
- `HealthBridge/CalendarBridge.swift`, `CalendarPlanView.swift`: orari occupati, calendario Workouts, importazione del piano.
- `HealthBridge/Training/`: parser piano, archivio sessioni, schermate serie per serie, comandi Attività Live.
- `HealthBridge/WaterSection.swift`, `WaterHistoryView.swift`: acqua oggi, cronologia, giorni passati.
- `HealthBridge/Briefing/`: posizione, agenda, promemoria e l'azione Comandi Rapidi per il briefing opzionale.
- `HealthBridgeWidget/`: widget stato, widget acqua e controllo, Attività Live dell'allenamento.
- `Shared/`: codice compilato in entrambi i target; `Secrets.swift` è generato.
- `HealthBridge.entitlements`: HealthKit, consegna in background, App Group.
- `server/`: il Worker, le sue migrazioni e il suo [README](server/README.md).
- `scripts/make-secrets.sh`: genera `Shared/Secrets.swift`. `scripts/renew.sh`: rifirma l'app. `scripts/make-icon.swift`: disegna l'icona dell'app.

Il progetto Xcode usa cartelle sincronizzate: i nuovi file Swift dentro `HealthBridge/`, `HealthBridgeWidget/` e `Shared/` entrano nel progetto da soli.

## Licenza

[MIT](LICENSE)
