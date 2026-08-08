# Chart Helm — `chart/`

Il chart con cui la piattaforma distribuisce l'app: **Deployment + Service +
HTTPRoute**, più un hook **PreSync** che crea il database di questa versione e un
Secret per le variabili d'ambiente. Poco da toccare, e mai per configurare: i valori
arrivano da fuori. Il perché delle scelte è in `../docs/decisions.md` §10.

## Chi riempie cosa

Quasi tutti i valori di `values.yaml` sono **sovrascritti per-branch**
dall'ApplicationSet della piattaforma, non da te: `hostname`, `image.tag` (il tag
immutabile `sha-<short>` del commit), `commitSha`, `otel.endpoint` (non vuoto **solo**
su `main`), `postgres.*` (l'istanza dedicata al progetto) e `appEnv.encoded` (la
configurazione impostata dalla pagina **Configurazione** di nedo). Scriverli qui non ha
effetto.

Quello che invece è **nostro** è il blocco `app:` — `cookieSecure`,
`schedulerEnabled`, `logLevel` — più `resources:`, dichiarate esplicitamente perché il
boot esegue le migrazioni e lo scheduler tiene una connessione longeva: ereditare i
default del namespace qui non va bene.

## La trappola del cookie `Secure`

`app.cookieSecure` è `false` **di proposito**, e va lasciato così finché la
piattaforma serve `http://` (`httproute.yaml` non ha configurazione TLS). Un cookie
`Secure` viene **scartato in silenzio** dal browser su HTTP: il login risponde `204`,
poi ogni richiesta successiva è `401`, e **nei log non compare nulla**. Passa a `true`
il giorno in cui arriva TLS, non prima.

## Perché `APP_PASSWORD` e `SESSION_SECRET` non sono in `env:`

Arrivano dall'`envFrom` (il Secret costruito da `appEnv.encoded`), cioè dalla pagina
Configurazione. Erano due `env:` con `secretKeyRef` verso un Secret creato a mano, ed è
stato rimosso per una ragione che è facile reintrodurre senza accorgersene: **in
Kubernetes un `env:` esplicito VINCE su `envFrom`**, quindi lasciarli lì avrebbe
ignorato in silenzio i valori impostati dalla UI.

Quindi: **non aggiungere una variabile dichiarata in `self-en.json` come `env:` qui.**
E nessun segreto in `values.yaml`, che sta in git.

Il comportamento in assenza di valori è voluto: nessun Secret ⇒ variabili assenti ⇒
**locked mode** (`503 not_configured` su `/api/*`, `/healthz` 200), non un crashloop —
un crashloop su questa piattaforma non lascia log leggibili nella UI.

## Il resto del contratto

- `templates/app-env-secret.yaml` è **della piattaforma** (marcato
  `self-en-contract: <n>`): viene riscritto, quindi modificarlo significa perdere le
  modifiche.
- `containerPort` deve restare la porta su cui ascolta il backend (`PORT`) e la
  readinessProbe deve puntare a `/healthz`. `/healthz` risponde 200 anche in locked
  mode e mentre le migrazioni girano: è deliberato, non un bug da "sistemare".
- L'`HTTPRoute` deve restare agganciato al Gateway condiviso (`gateway.name` /
  `gateway.namespace`).
- `replicaCount > 1` è sicuro: lo scheduler in-process elegge un leader con
  `pg_try_advisory_lock`.
