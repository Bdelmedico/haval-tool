import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RefreshCwIcon, ArrowLeftIcon, PlayIcon, BugIcon } from 'lucide-react'
import { Terminal as TerminalComponent, DebugModal } from '../components'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { error } from '@tauri-apps/plugin-log';

export const Terminal = () => {
  const [output, setOutput] = useState<string[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [gatewayIp, setGatewayIp] = useState<string>('')
  const [isDebugEnabled, setIsDebugEnabled] = useState(false)
  const [isDebugModalOpen, setIsDebugModalOpen] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const executionStartRef = useRef<number | null>(null)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const installMode = searchParams.get('mode') || 'update'
  const installVersion = searchParams.get('version') || 'latest'

  // Escuta eventos telnet-output do backend (saída do install.sh em tempo real)
  useEffect(() => {
    const unlisten = listen<string>('telnet-output', (event) => {
      setOutput((prev) => [...prev, event.payload])
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  // Timer de tempo decorrido durante execução
  useEffect(() => {
    if (!isExecuting) {
      executionStartRef.current = null
      return
    }
    executionStartRef.current = Date.now()
    setElapsedSeconds(0)
    const interval = setInterval(() => {
      if (executionStartRef.current) {
        setElapsedSeconds(Math.floor((Date.now() - executionStartRef.current) / 1000))
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [isExecuting])

  useEffect(() => {
    setOutput([])
    setIsConnected(false)
    setIsConnecting(false)
    setIsExecuting(false)

    const setup = async () => {
      const gateway = await invoke<string>('get_gateway')
      setGatewayIp(gateway)
      setOutput((prev: string[]) => [...prev, `Gateway: ${gateway}`])
      setOutput((prev: string[]) => [...prev, `Modo: ${installMode === 'clean' ? 'Instalação Limpa' : 'Atualizar / Instalar'}`])
      setOutput((prev: string[]) => [...prev, `Versão: ${installVersion === 'latest' ? 'Mais recente (automático)' : installVersion.split('/').pop()?.replace('.apk', '') ?? installVersion}`])

      try {
        const isAlreadyConnected = await invoke<boolean>('is_connected')
        if (isAlreadyConnected) {
          setIsConnected(true)
          setOutput((prev: string[]) => [...prev, 'Conexão já estabelecida!'])
        } else {
          await invoke('connect_to_telnet')
          setIsConnected(true)
          setOutput((prev: string[]) => [...prev, 'Conexão estabelecida com sucesso!'])
        }
      } catch (e) {
        setIsConnected(false)
        setOutput((prev: string[]) => [...prev, `Erro ao conectar ao telnet: ${e}`])
      }
    }

    setup();
  }, []);

  const executeInstallScript = async () => {
    setIsExecuting(true)
    setIsDebugEnabled(false)

    setTimeout(() => {
      setIsDebugEnabled(true)
      setOutput((prev: string[]) => [...prev, '🔧 Botão de debug habilitado'])
    }, 2000)

    // Se modo limpo: desinstalar apps e limpar /tmp antes de instalar
    if (installMode === 'clean') {
      setOutput((prev: string[]) => [...prev, '🗑️ Iniciando limpeza completa...'])
      try {
        await invoke('uninstall_apps')
        setOutput((prev: string[]) => [...prev, '✅ Apps desinstalados!'])
      } catch (e) {
        setOutput((prev: string[]) => [...prev, `⚠️ Aviso na desinstalação: ${e}`])
      }
      try {
        await invoke('clean_tmp')
        setOutput((prev: string[]) => [...prev, '✅ /tmp limpo!'])
      } catch (e) {
        setOutput((prev: string[]) => [...prev, `⚠️ Aviso na limpeza do /tmp: ${e}`])
      }
      setOutput((prev: string[]) => [...prev, ''])
    }

    // Injeta o script com a versão selecionada (null = latest)
    const havalApkUrl = installVersion === 'latest' ? null : installVersion

    try {
      await invoke('inject_script', { havalApkUrl })
      setOutput((prev: string[]) => [...prev, 'Script injetado com sucesso!'])
      setOutput((prev: string[]) => [...prev, 'Aguarde a instalação...'])
    } catch (e) {
      error(e as string);
      setOutput((prev: string[]) => [...prev, 'Erro ao injetar script!'])
      setIsExecuting(false);
      return
    }

    try {
      await invoke('is_installed')
      navigate('/install/success');
    } catch (e) {
      error(e as string);
      setOutput((prev: string[]) => [...prev, 'Falhou. Clique recomeçar para tentar novamente!'])
      setIsExecuting(false);
    }
  }

  const handleRestart = async () => {
    setOutput([])
    setIsConnected(false)
    setIsConnecting(false)
    setIsExecuting(false)
    setGatewayIp('')
    setIsDebugEnabled(false)

    try {
      setIsConnecting(true)
      setOutput((prev: string[]) => [...prev, 'Desconectando...'])

      await invoke('disconnect_from_telnet')

      setOutput((prev: string[]) => [...prev, 'Tentando reconectar...'])
      await invoke('connect_to_telnet')

      const connected = await invoke<boolean>('is_connected')
      if (connected) {
        setIsConnected(true)
        setOutput((prev: string[]) => [...prev, 'Reconexão estabelecida com sucesso!'])
      } else {
        setIsConnected(false)
        setOutput((prev: string[]) => [...prev, 'Falha na verificação da conexão!'])
      }
    } catch (e) {
      setIsConnected(false)
      setOutput((prev: string[]) => [...prev, `Erro ao reconectar ao telnet: ${e}`])
    } finally {
      setIsConnecting(false)
    }
  }

  const handleBack = () => {
    handleRestart();
    navigate('/')
  }

  const modeLabel = installMode === 'clean' ? 'Instalação Limpa' : 'Instalação em Progresso'

  const formatElapsed = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`
  }

  return (
    <div className="flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="bg-white/10 backdrop-blur-md p-6 rounded-2xl shadow-2xl w-full max-w-2xl border border-white/20">
          <TerminalComponent title={modeLabel} output={output} isConnecting={isConnecting} isExecuting={isExecuting} />

          {/* Status de conexão */}
          <div className="mb-4">
            <div className="flex justify-between text-sm text-gray-300 mb-2">
              <span>Status: {isConnecting ? 'Conectando...' : isConnected ? `Conectado (${gatewayIp})` : 'Desconectado'}</span>
              <span className={`flex items-center gap-1 ${isConnected ? 'text-green-400' : isConnecting ? 'text-yellow-400' : 'text-red-400'}`}>
                <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-400' : isConnecting ? 'bg-yellow-400 animate-pulse' : 'bg-red-400'}`}></div>
                {isConnected ? 'Online' : isConnecting ? 'Conectando' : 'Offline'}
              </span>
            </div>

            {isConnected && !isExecuting && (
              <button
                onClick={executeInstallScript}
                className={`w-full mb-4 flex items-center justify-center gap-2 text-white py-3 px-5 rounded-xl transition-all duration-300 shadow-lg ${
                  installMode === 'clean'
                    ? 'bg-red-600 hover:bg-red-700 hover:shadow-red-600/30'
                    : 'bg-green-600 hover:bg-green-700 hover:shadow-green-600/30'
                }`}
              >
                <PlayIcon size={18} />
                <span>
                  {installMode === 'clean' ? 'Executar Instalação Limpa' : 'Executar Script de Instalação'}
                </span>
              </button>
            )}

            {isExecuting && (
              <div className={`w-full mb-4 flex items-center justify-center gap-3 text-white py-3 px-5 rounded-xl ${
                installMode === 'clean' ? 'bg-red-700' : 'bg-yellow-600'
              }`}>
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full flex-shrink-0"></div>
                <div className="flex flex-col items-start">
                  <span className="font-medium">{installMode === 'clean' ? 'Executando Instalação Limpa...' : 'Executando Script...'}</span>
                  <span className="text-xs opacity-80">⏱️ Executando há {formatElapsed(elapsedSeconds)} — aguarde, downloads podem demorar</span>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-between gap-4">
            <button
              onClick={handleBack}
              className="flex items-center justify-center gap-2 bg-gray-700 text-white py-3 px-5 rounded-xl hover:bg-gray-600 transition-all duration-300 flex-1 border border-gray-600"
            >
              <ArrowLeftIcon size={18} />
              <span>Voltar</span>
            </button>
            <button
              onClick={handleRestart}
              disabled={isConnecting || isExecuting}
              className={`flex items-center justify-center gap-2 py-3 px-5 rounded-xl transition-all duration-300 flex-1 ${!(isConnecting || isExecuting) ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg hover:shadow-blue-600/30' : 'bg-gray-800 text-gray-500 cursor-not-allowed'}`}
            >
              <RefreshCwIcon size={18} />
              <span>Recomeçar</span>
            </button>
          </div>

          {isExecuting && (
            <button
              onClick={() => setIsDebugModalOpen(true)}
              disabled={!isDebugEnabled}
              className={`mt-4 w-full flex items-center justify-center gap-2 py-3 px-5 rounded-xl transition-all duration-300 ${
                isDebugEnabled
                  ? 'bg-purple-600 text-white hover:bg-purple-700 shadow-lg hover:shadow-purple-600/30'
                  : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }`}
            >
              <BugIcon size={18} />
              <span>
                {isDebugEnabled ? '🔧 Abrir Debug' : '⏳ Debug disponível em 2s'}
              </span>
            </button>
          )}
        </div>
      </div>

      <DebugModal
        isOpen={isDebugModalOpen}
        onClose={() => setIsDebugModalOpen(false)}
        title="Debug - Instalação"
      />
    </div>
  )
}
