use std::net::Ipv4Addr;
use std::time::Duration;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tauri::Emitter;

#[derive(Clone)]
pub struct ConnectionState {
    stream: Arc<Mutex<Option<TcpStream>>>,
}

#[derive(Debug, thiserror::Error)]
enum ApiError {
    #[error("Não foi possível encontrar o Haval na rede (sub-redes testadas: {0})")]
    HavalNotFound(String),
    #[error("A conexão Telnet não está estabelecida")]
    NotConnected,
    #[error("Já está conectado")]
    AlreadyConnected,
    #[error("Rollback detectado durante a verificação de instalação")]
    RollbackDetected,
    #[error("A resposta esperada não foi recebida a tempo (timeout)")]
    Timeout,
    #[error("Falha ao baixar o script de instalação")]
    DownloadFailed,
    #[error("Erro ao buscar releases do GitHub")]
    GithubError,
    #[error("IP do PC na rede do Haval não encontrado")]
    LocalIpNotFound,
    #[error("Erro de I/O: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for ApiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[derive(serde::Serialize, Clone)]
pub struct ReleaseInfo {
    tag_name: String,
    download_url: String,
}

// Tenta achar o IP do Haval na rede: primeiro pelo hotspot direto do carro
// (gateway 192.168.33.x), senao escaneia a rede local procurando um host
// com a porta 23 (telnet) aberta (ex: internet compartilhada do celular)
#[tauri::command]
async fn find_haval_ip() -> Result<String, ApiError> {
    if let Ok(gateway) = default_net::get_default_gateway() {
        let gw_ip = gateway.ip_addr.to_string();
        if gw_ip.starts_with("192.168.33.") {
            return Ok(gw_ip);
        }
    }

    scan_for_haval_ip().await
}

// Escaneia as sub-redes locais (/24) procurando um host com a porta 23 (telnet) aberta.
// So considera interfaces com gateway configurado (rede "de verdade", ex: Wi-Fi),
// ignorando adaptadores virtuais/host-only (VirtualBox, VPNs sem rota padrao, etc.)
async fn scan_for_haval_ip() -> Result<String, ApiError> {
    let interfaces = default_net::get_interfaces();
    let mut scanned = Vec::new();

    for iface in &interfaces {
        let Some(gateway) = &iface.gateway else { continue };
        let gateway_ip = gateway.ip_addr.to_string();

        for addr in &iface.ipv4 {
            let ip = addr.addr;
            if ip.is_loopback() || ip.is_link_local() {
                continue;
            }

            let octets = ip.octets();
            scanned.push(format!("{}.{}.{}.0/24", octets[0], octets[1], octets[2]));
            let mut tasks = Vec::new();

            for host in 1u8..255 {
                if host == octets[3] {
                    continue;
                }
                let candidate = Ipv4Addr::new(octets[0], octets[1], octets[2], host);
                if candidate.to_string() == gateway_ip {
                    continue;
                }
                tasks.push(tokio::spawn(async move {
                    let addr = format!("{}:23", candidate);
                    tokio::time::timeout(Duration::from_millis(400), TcpStream::connect(&addr))
                        .await
                        .ok()
                        .and_then(|r| r.ok())
                        .map(|_| candidate.to_string())
                }));
            }

            for task in tasks {
                if let Ok(Some(found)) = task.await {
                    return Ok(found);
                }
            }
        }
    }

    Err(ApiError::HavalNotFound(scanned.join(", ")))
}

// Equivalente a: api.isHavalHotspot
#[tauri::command]
async fn is_haval_hotspot() -> Result<(), ApiError> {
    find_haval_ip().await.map(|_| ())
}

// Equivalente a: api.isConnected
#[tauri::command]
async fn is_connected(state: tauri::State<'_, ConnectionState>) -> Result<bool, ApiError> {
    let stream_lock = state.stream.lock().await;
    Ok(stream_lock.is_some())
}

// Equivalente a: api.connectToTelnet
#[tauri::command]
async fn connect_to_telnet(state: tauri::State<'_, ConnectionState>) -> Result<(), ApiError> {
    let mut stream_lock = state.stream.lock().await;

    if stream_lock.is_some() {
        println!("Já existe uma conexão ativa.");
        return Err(ApiError::AlreadyConnected);
    }

    let ip = find_haval_ip().await?;
    let addr = format!("{}:23", ip);

    println!("Tentando conectar ao Telnet em {}...", addr);
    let stream = TcpStream::connect(&addr).await?;
    println!("Conexão estabelecida com sucesso!");

    *stream_lock = Some(stream);
    Ok(())
}

// Equivalente a: api.disconnectFromTelnet
#[tauri::command]
async fn disconnect_from_telnet(state: tauri::State<'_, ConnectionState>) -> Result<(), ApiError> {
    let mut stream_lock = state.stream.lock().await;
    if stream_lock.is_some() {
        *stream_lock = None;
        println!("Conexão fechada!");
    }
    Ok(())
}

#[tauri::command]
async fn send_command(
    command: String,
    state: tauri::State<'_, ConnectionState>,
) -> Result<(), ApiError> {
    let mut stream_lock = state.stream.lock().await;
    if let Some(stream) = &mut *stream_lock {
        println!("Enviando comando: {}", command);
        let command_with_newline = format!("{}\n", command);
        stream.write_all(command_with_newline.as_bytes()).await?;
        stream.flush().await?;
    } else {
        return Err(ApiError::NotConnected);
    }
    Ok(())
}

async fn send_command_with_event(
    command: String,
    state: tauri::State<'_, ConnectionState>,
    app: &tauri::AppHandle,
) -> Result<(), ApiError> {
    let _ = app.emit("telnet-output", format!("$ {}", command));
    send_command(command, state).await
}

// Busca as releases disponíveis do haval-app-tool-multimidia no GitHub
#[tauri::command]
async fn list_haval_releases() -> Result<Vec<ReleaseInfo>, ApiError> {
    let client = reqwest::Client::builder()
        .user_agent("haval-tool")
        .build()
        .map_err(|_| ApiError::GithubError)?;

    let response: serde_json::Value = client
        .get("https://api.github.com/repos/bobaoapae/haval-app-tool-multimidia/releases")
        .send()
        .await
        .map_err(|_| ApiError::GithubError)?
        .json()
        .await
        .map_err(|_| ApiError::GithubError)?;

    let releases = response
        .as_array()
        .ok_or(ApiError::GithubError)?
        .iter()
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?.to_string();
            let assets = r["assets"].as_array()?;
            let url = assets
                .iter()
                .find(|a| {
                    a["name"]
                        .as_str()
                        .map(|n| n.ends_with(".apk"))
                        .unwrap_or(false)
                })?["browser_download_url"]
                .as_str()?
                .to_string();
            Some(ReleaseInfo {
                tag_name: tag,
                download_url: url,
            })
        })
        .take(15)
        .collect();

    Ok(releases)
}

// Desinstala o Haval App e o Shizuku do dispositivo
#[tauri::command]
async fn uninstall_apps(
    app: tauri::AppHandle,
    state: tauri::State<'_, ConnectionState>,
) -> Result<(), ApiError> {
    if !is_connected(state.clone()).await? {
        return Err(ApiError::NotConnected);
    }

    let _ = app.emit("telnet-output", "🗑️ Desinstalando Haval App...");
    send_command_with_event(
        "pm uninstall br.com.redesurftank.havalshisuku".to_string(),
        state.clone(),
        &app,
    )
    .await?;
    tokio::time::sleep(Duration::from_secs(3)).await;

    let _ = app.emit("telnet-output", "🗑️ Desinstalando Shizuku...");
    send_command_with_event(
        "pm uninstall moe.shizuku.privileged.api".to_string(),
        state.clone(),
        &app,
    )
    .await?;
    tokio::time::sleep(Duration::from_secs(3)).await;

    let _ = app.emit("telnet-output", "✅ Desinstalação concluída!");
    Ok(())
}

// Remove os arquivos temporários de /data/local/tmp do dispositivo
#[tauri::command]
async fn clean_tmp(
    app: tauri::AppHandle,
    state: tauri::State<'_, ConnectionState>,
) -> Result<(), ApiError> {
    if !is_connected(state.clone()).await? {
        return Err(ApiError::NotConnected);
    }

    let _ = app.emit("telnet-output", "🧹 Limpando arquivos temporários...");
    send_command_with_event(
        "rm -f /data/local/tmp/fridaserver /data/local/tmp/fridainject /data/local/tmp/system_server.js /data/local/tmp/shizuku.apk /data/local/tmp/haval.apk /data/local/tmp/install.sh".to_string(),
        state.clone(),
        &app,
    )
    .await?;
    tokio::time::sleep(Duration::from_secs(2)).await;

    let _ = app.emit("telnet-output", "✅ Arquivos temporários removidos!");
    Ok(())
}

// Encontra o IP do PC na mesma sub-rede (/24) do IP do Haval
fn find_local_ip_in_subnet(haval_ip: &str) -> Result<String, ApiError> {
    let target: Ipv4Addr = haval_ip.parse().map_err(|_| ApiError::LocalIpNotFound)?;
    let target_octets = target.octets();

    let interfaces = default_net::get_interfaces();
    for iface in &interfaces {
        for addr in &iface.ipv4 {
            let ip = addr.addr;
            let octets = ip.octets();
            if octets[0] == target_octets[0]
                && octets[1] == target_octets[1]
                && octets[2] == target_octets[2]
                && ip != target
            {
                return Ok(ip.to_string());
            }
        }
    }
    Err(ApiError::LocalIpNotFound)
}

// Serve um arquivo APK local via HTTP para que o carro possa baixar
async fn serve_apk_file(mut stream: tokio::net::TcpStream, file_path: String) {
    // Drena o cabeçalho HTTP recebido
    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..n]);
    let is_head = request.starts_with("HEAD");

    match tokio::fs::read(&file_path).await {
        Ok(content) => {
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/vnd.android.package-archive\r\nContent-Disposition: attachment; filename=\"haval.apk\"\r\nConnection: close\r\n\r\n",
                content.len()
            );
            let _ = stream.write_all(headers.as_bytes()).await;
            if !is_head {
                let _ = stream.write_all(&content).await;
            }
            let _ = stream.flush().await;
        }
        Err(e) => {
            let body = format!("Erro ao ler arquivo: {}", e);
            let response = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    }
}

// Inicia um servidor HTTP temporário que serve o APK local para o carro
// Retorna a URL que o carro deve usar para baixar o APK
#[tauri::command]
async fn start_local_apk_server(file_path: String) -> Result<String, ApiError> {
    let haval_ip = find_haval_ip().await?;
    let local_ip = find_local_ip_in_subnet(&haval_ip)?;

    // Bind numa porta livre aleatória
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await?;
    let port = listener.local_addr()?.port();

    println!("Servidor APK local iniciado em {}:{}", local_ip, port);

    // Roda em background até o app fechar
    let fp = file_path.clone();
    tokio::spawn(async move {
        loop {
            if let Ok((stream, addr)) = listener.accept().await {
                println!("Conexão de {}", addr);
                let file = fp.clone();
                tokio::spawn(serve_apk_file(stream, file));
            }
        }
    });

    Ok(format!("http://{}:{}/haval.apk", local_ip, port))
}

// Equivalente a: api.injectScript
#[tauri::command]
async fn inject_script(
    app: tauri::AppHandle,
    state: tauri::State<'_, ConnectionState>,
    haval_apk_url: Option<String>,
) -> Result<(), ApiError> {
    let client = reqwest::Client::new();
    let mut install_script = client
        .get("https://raw.githubusercontent.com/Bdelmedico/haval-tool/refs/heads/main/install.sh")
        .send()
        .await
        .map_err(|_| ApiError::DownloadFailed)?
        .text()
        .await
        .map_err(|_| ApiError::DownloadFailed)?;

    // Se uma versão específica foi solicitada, substitui o download de latest pelo URL direto
    if let Some(ref url) = haval_apk_url {
        install_script = install_script.replace(
            r#"$(get_latest_release "https://github.com/bobaoapae/haval-app-tool-multimidia")"#,
            url,
        );
    }

    // Sempre reconecta para garantir conexão fresca (evita falhas por conexão morta/inativa)
    let _ = app.emit("telnet-output", "🔌 Reconectando ao dispositivo...");
    {
        let mut stream_lock = state.stream.lock().await;
        *stream_lock = None;
    }
    connect_to_telnet(state.clone()).await?;

    // Remove haval.apk cacheado após reconectar (só quando URL específica fornecida)
    if haval_apk_url.is_some() {
        let _ = app.emit("telnet-output", "🗑️ Removendo APK em cache...");
        send_command_with_event(
            "rm -f /data/local/tmp/haval.apk".to_string(),
            state.clone(),
            &app,
        )
        .await?;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    let install_script_escaped = install_script.split('\n').collect::<Vec<_>>().join("\\n");
    let echo_command = format!(
        r#"echo -e '{}' > /data/local/tmp/install.sh"#,
        install_script_escaped
    );

    let _ = app.emit("telnet-output", "📦 Enviando script para o dispositivo...");
    send_command_with_event(echo_command, state.clone(), &app).await?;
    tokio::time::sleep(Duration::from_secs(2)).await;

    let _ = app.emit("telnet-output", "🔧 Definindo permissões de execução...");
    send_command_with_event(
        "chmod +x /data/local/tmp/install.sh".to_string(),
        state.clone(),
        &app,
    )
    .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    let _ = app.emit("telnet-output", "🚀 Executando script de instalação...");
    send_command_with_event(
        "cd /data/local/tmp && ./install.sh".to_string(),
        state.clone(),
        &app,
    )
    .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;

    Ok(())
}

#[tauri::command]
async fn start_telnet_monitor(
    app: tauri::AppHandle,
    _state: tauri::State<'_, ConnectionState>,
) -> Result<(), ApiError> {
    let _ = app.emit("telnet-output", "🚀 Monitor de telnet iniciado");
    let _ = app.emit("telnet-output", "📡 Conectado ao sistema telnet");
    let _ = app.emit("telnet-output", "⚡ Aguardando comandos e respostas...");
    println!("Monitor de telnet iniciado (modo simplificado)");
    Ok(())
}

// Equivalente a: api.isInstalled
#[tauri::command]
async fn is_installed(
    app: tauri::AppHandle,
    state: tauri::State<'_, ConnectionState>
) -> Result<(), ApiError> {
    let operation = async {
        let mut stream_lock = state.stream.lock().await;

        if let Some(stream) = stream_lock.as_mut() {
            let mut reader = BufReader::new(stream);
            let mut line_buffer = Vec::new();

            loop {
                line_buffer.clear();

                let bytes_read = reader.read_until(b'\n', &mut line_buffer).await?;
                if bytes_read == 0 {
                    return Err(ApiError::NotConnected);
                }

                let response = match String::from_utf8_lossy(&line_buffer).trim().to_lowercase() {
                    s if s.is_empty() => {
                        println!("Linha vazia ignorada");
                        continue;
                    }
                    s => s.to_string(),
                };

                println!("Resposta recebida: '{}'", response);
                let _ = app.emit("telnet-output", response.clone());

                if response == "fb5f2f27be2de104ac2b192f3e874dda" {
                    return Ok(());
                } else if response == "fff66e9b3d962fa319c8068b5c1997cd" {
                    return Err(ApiError::RollbackDetected);
                }
            }
        } else {
            Err(ApiError::NotConnected)
        }
    };

    match tokio::time::timeout(Duration::from_secs(600), operation).await {
        Ok(result) => result,
        Err(_) => Err(ApiError::Timeout),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(ConnectionState {
            stream: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            find_haval_ip,
            is_haval_hotspot,
            connect_to_telnet,
            disconnect_from_telnet,
            send_command,
            is_connected,
            inject_script,
            is_installed,
            start_telnet_monitor,
            list_haval_releases,
            uninstall_apps,
            clean_tmp,
            start_local_apk_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
