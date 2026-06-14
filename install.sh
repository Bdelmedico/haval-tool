#!/bin/sh

# Variaveis globais
ROLLBACK_ENABLED=true

# Funcoes basicas
log() { echo "[$1] $(date +%H:%M:%S) $2"; }
die() { log "ERR" "$1"; exit 1; }

# Rollback simples
cleanup() {
    [ $? -eq 0 ] && exit 0
    [ "$ROLLBACK_ENABLED" = false ] && exit 0

    log "INFO" "Executando rollback..."
    pkill -f fridaserver 2>/dev/null || true
    rm -f shizuku.apk haval.apk 2>/dev/null || true
    log "INFO" "Rollback concluido"
    echo "fff66e9b3d962fa319c8068b5c1997cd"
}
trap cleanup EXIT

# Funcoes de versao
get_latest_release() {
    repo=${1#https://github.com/}; repo=${repo%.git}
    curl -s "https://api.github.com/repos/$repo/releases/latest" | grep browser_download_url | cut -d\" -f4
}

# Download com verificacao e progresso visivel
download() {
    [ -f "$2" ] && [ -s "$2" ] && { log "INFO" "$3 ja esta em cache, pulando download"; return; }
    log "INFO" "Iniciando download de $3... (pode demorar varios minutos)"
    curl -L -o "$2" "$1" 2>/dev/null &
    local curl_pid=$!
    while kill -0 "$curl_pid" 2>/dev/null; do
        sleep 5
        if [ -f "$2" ]; then
            local sz
            sz=$(wc -c < "$2" 2>/dev/null); sz=${sz:-0}
            log "INFO" "  $3: $((sz / 1024)) KB recebidos..."
        else
            log "INFO" "  Baixando $3: aguardando resposta do servidor..."
        fi
    done
    wait "$curl_pid" || die "Falha no download de $2"
    [ -f "$2" ] && [ -s "$2" ] || die "Arquivo $2 vazio apos download"
    local final
    final=$(wc -c < "$2" 2>/dev/null); final=${final:-0}
    log "INFO" "Download de $3 concluido! ($((final / 1024)) KB)"
}

# Instalacao de aplicativo
install_app() {
    local apk="$1" name="$2"
    [ ! -f "$apk" ] && die "$apk nao encontrado"

    log "INFO" "Instalando $name..."
    pm install -r "$apk" || die "Falha na instalacao de $name"
}

# Script principal
main() {
    log "INFO" "Iniciando instalacao compacta..."
    cd . || die "Falha ao acessar diretorio"

    # Desinstalacao e limpeza antes de instalar
    log "INFO" "Fase 0: Desinstalando versoes anteriores..."
    pkill -f fridaserver 2>/dev/null || true
    pm uninstall br.com.redesurftank.havalshisuku 2>/dev/null || true
    pm uninstall moe.shizuku.privileged.api 2>/dev/null || true
    log "INFO" "Fase 0: Limpando arquivos temporarios..."
    rm -f fridaserver fridainject system_server.js shizuku.apk haval.apk 2>/dev/null || true
    log "INFO" "Fase 0: Limpeza concluida"

    # Downloads
    log "INFO" "Fase 1: Downloads"
    download "https://haval.joaoiot.com.br/fridaserver.rar" "fridaserver" "fridaserver"
    download "https://haval.joaoiot.com.br/fridainject.rar" "fridainject" "fridainject"
    download "https://haval.joaoiot.com.br/system_server.js" "system_server.js" "system_server.js"
    download "$(get_latest_release "https://github.com/RikkaApps/Shizuku")" "shizuku.apk" "Shizuku APK"
    download "$(get_latest_release "https://github.com/bobaoapae/haval-app-tool-multimidia")" "haval.apk" "Haval APK"

    # Permissoes
    log "INFO" "Fase 2: Permissoes"
    chmod +x fridaserver fridainject || die "Falha nas permissoes"

    # Fridaserver
    log "INFO" "Fase 3: Servicos"
    if ! pgrep fridaserver >/dev/null; then
        [ -x "./fridaserver" ] || die "fridaserver nao executavel"
        setsid ./fridaserver >/dev/null 2>&1 < /dev/null &
        sleep 2
        pgrep fridaserver >/dev/null || die "fridaserver nao iniciou"
    fi

    # Injecao
    [ -f "system_server.js" ] || die "system_server.js nao encontrado"
    SYSTEM_PID=$(pidof system_server) || die "system_server nao encontrado"
    ./fridainject -p "$SYSTEM_PID" -s system_server.js &
    sleep 1
    log "INFO" "Injecao iniciada"

    # Instalacoes
    log "INFO" "Fase 4: Aplicativos"
    install_app "shizuku.apk" "Shizuku"
    install_app "haval.apk" "Haval App"

    # Limpa arquivos temporarios
    rm -f shizuku.apk haval.apk
    ROLLBACK_ENABLED=false

    echo "🎉 Instalacao concluida!"
    echo "fb5f2f27be2de104ac2b192f3e874dda"
}

# Executa
main "$@"
