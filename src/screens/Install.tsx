import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeftIcon, DownloadIcon, RefreshCwIcon, TrashIcon, LinkIcon, GithubIcon, FolderIcon, FileIcon } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

type ReleaseInfo = {
  tag_name: string
  download_url: string
}

type InstallMode = 'clean' | 'update'
type ApkSource = 'github' | 'url' | 'local'

export const Install = () => {
  const [releases, setReleases] = useState<ReleaseInfo[]>([])
  const [isLoadingReleases, setIsLoadingReleases] = useState(false)
  const [releasesError, setReleasesError] = useState<string | null>(null)
  const [selectedGithubVersion, setSelectedGithubVersion] = useState<string>('latest')
  const [installMode, setInstallMode] = useState<InstallMode>('update')
  const [apkSource, setApkSource] = useState<ApkSource>('github')
  const [customUrl, setCustomUrl] = useState<string>('')
  const [localFilePath, setLocalFilePath] = useState<string>('')
  const [localServerUrl, setLocalServerUrl] = useState<string>('')
  const [isStartingServer, setIsStartingServer] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const fetchReleases = async () => {
      setIsLoadingReleases(true)
      setReleasesError(null)
      try {
        const data = await invoke<ReleaseInfo[]>('list_haval_releases')
        setReleases(data)
      } catch {
        setReleasesError('Não foi possível buscar as versões do GitHub.')
      } finally {
        setIsLoadingReleases(false)
      }
    }
    fetchReleases()
  }, [])

  const handlePickFile = async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'APK Android', extensions: ['apk'] }],
    })
    if (selected && typeof selected === 'string') {
      setLocalFilePath(selected)
      setLocalServerUrl('')
      setServerError(null)
    }
  }

  const handleStartLocalServer = async () => {
    if (!localFilePath.trim()) return
    setServerError(null)
    setIsStartingServer(true)
    try {
      const url = await invoke<string>('start_local_apk_server', { filePath: localFilePath.trim() })
      setLocalServerUrl(url)
    } catch (e: any) {
      setServerError(`Erro ao iniciar servidor: ${e}`)
    } finally {
      setIsStartingServer(false)
    }
  }

  const getResolvedVersionUrl = (): string | null => {
    if (apkSource === 'github') {
      return selectedGithubVersion === 'latest' ? null : selectedGithubVersion
    }
    if (apkSource === 'url') {
      return customUrl.trim() || null
    }
    if (apkSource === 'local') {
      return localServerUrl || null
    }
    return null
  }

  const canContinue = (): boolean => {
    if (apkSource === 'url') return customUrl.trim().length > 0
    if (apkSource === 'local') return localServerUrl.length > 0
    return true
  }

  const handleContinue = () => {
    const version = getResolvedVersionUrl() ?? 'latest'
    const params = new URLSearchParams({ mode: installMode, version })
    navigate(`/install/warning?${params.toString()}`)
  }

  const selectedGithubLabel =
    selectedGithubVersion === 'latest'
      ? 'Mais recente (automático)'
      : releases.find(r => r.download_url === selectedGithubVersion)?.tag_name ?? selectedGithubVersion

  return (
    <div className="flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center p-6">
        <div className="bg-white/10 backdrop-blur-md p-8 rounded-2xl shadow-2xl w-full max-w-md border border-white/20">
          <div className="flex justify-center mb-6">
            <DownloadIcon size={32} className="text-blue-400" />
          </div>
          <h1 className="text-2xl font-bold text-center mb-6 text-white">
            Instalação de Aplicações
          </h1>

          {/* Modo de instalação */}
          <div className="mb-6">
            <p className="text-gray-400 text-sm mb-3 font-medium">Modo de instalação:</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setInstallMode('update')}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                  installMode === 'update'
                    ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                    : 'bg-gray-800/50 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                }`}
              >
                <RefreshCwIcon size={20} />
                <span className="text-sm font-semibold">Atualizar</span>
                <span className="text-xs text-center opacity-70 leading-tight">Instala sem remover o atual</span>
              </button>
              <button
                onClick={() => setInstallMode('clean')}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                  installMode === 'clean'
                    ? 'bg-red-600/30 border-red-500 text-red-300'
                    : 'bg-gray-800/50 border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                }`}
              >
                <TrashIcon size={20} />
                <span className="text-sm font-semibold">Limpa + Instalar</span>
                <span className="text-xs text-center opacity-70 leading-tight">Desinstala tudo, limpa /tmp e reinstala</span>
              </button>
            </div>
            {installMode === 'clean' && (
              <p className="text-red-300 text-xs mt-2 px-1">
                ⚠️ Desinstala Haval App e Shizuku e remove todos os arquivos de /data/local/tmp.
              </p>
            )}
          </div>

          {/* Origem do APK */}
          <div className="mb-6">
            <p className="text-gray-400 text-sm mb-3 font-medium">Origem do APK:</p>

            <div className="grid grid-cols-3 gap-2 mb-4">
              <button
                onClick={() => setApkSource('github')}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-xs transition-all ${
                  apkSource === 'github'
                    ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                    : 'bg-gray-800/50 border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                <GithubIcon size={18} />
                <span className="font-medium">GitHub</span>
              </button>
              <button
                onClick={() => setApkSource('url')}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-xs transition-all ${
                  apkSource === 'url'
                    ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                    : 'bg-gray-800/50 border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                <LinkIcon size={18} />
                <span className="font-medium">URL direta</span>
              </button>
              <button
                onClick={() => setApkSource('local')}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-xs transition-all ${
                  apkSource === 'local'
                    ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                    : 'bg-gray-800/50 border-gray-600 text-gray-400 hover:border-gray-500'
                }`}
              >
                <FolderIcon size={18} />
                <span className="font-medium">Arquivo local</span>
              </button>
            </div>

            {apkSource === 'github' && (
              <div>
                {isLoadingReleases ? (
                  <div className="flex items-center gap-2 text-gray-400 text-sm py-2">
                    <div className="animate-spin h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full flex-shrink-0"></div>
                    <span>Buscando versões disponíveis...</span>
                  </div>
                ) : releasesError ? (
                  <div className="text-yellow-300 text-xs bg-yellow-900/20 border border-yellow-500/30 rounded-xl p-3">
                    {releasesError}
                    <br /><span className="text-gray-400">Será usada a versão mais recente automaticamente.</span>
                  </div>
                ) : (
                  <select
                    value={selectedGithubVersion}
                    onChange={e => setSelectedGithubVersion(e.target.value)}
                    className="w-full bg-gray-800 text-white border border-gray-600 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500 cursor-pointer"
                  >
                    <option value="latest">Mais recente (automático)</option>
                    {releases.map(r => (
                      <option key={r.tag_name} value={r.download_url}>{r.tag_name}</option>
                    ))}
                  </select>
                )}
                {selectedGithubVersion !== 'latest' && (
                  <p className="text-blue-300 text-xs mt-2 px-1">
                    📌 Versão: <strong>{selectedGithubLabel}</strong>
                  </p>
                )}
              </div>
            )}

            {apkSource === 'url' && (
              <div>
                <input
                  type="text"
                  value={customUrl}
                  onChange={e => setCustomUrl(e.target.value)}
                  placeholder="https://exemplo.com/haval.apk"
                  className="w-full bg-gray-800 text-white border border-gray-600 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-500 text-sm placeholder-gray-500"
                />
                <p className="text-gray-500 text-xs mt-2 px-1">
                  URL direta do APK — Google Drive, servidor próprio, etc.
                </p>
              </div>
            )}

            {apkSource === 'local' && (
              <div className="space-y-3">
                <button
                  onClick={handlePickFile}
                  className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl border text-sm font-medium transition-all bg-gray-700 text-white border-gray-500 hover:border-blue-500 hover:text-blue-300"
                >
                  <FolderIcon size={16} />
                  <span>Escolher arquivo APK...</span>
                </button>

                {localFilePath && (
                  <div className="flex items-center gap-2 bg-gray-800/60 border border-gray-600 rounded-xl px-3 py-2">
                    <FileIcon size={14} className="text-blue-400 flex-shrink-0" />
                    <span className="text-xs text-gray-300 truncate" title={localFilePath}>
                      {localFilePath.split(/[\\/]/).pop()}
                    </span>
                  </div>
                )}

                <button
                  onClick={handleStartLocalServer}
                  disabled={!localFilePath.trim() || isStartingServer}
                  className={`w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl border text-sm font-medium transition-all ${
                    !localFilePath.trim() || isStartingServer
                      ? 'bg-gray-800 text-gray-500 border-gray-700 cursor-not-allowed'
                      : 'bg-blue-600/20 text-blue-300 border-blue-500 hover:bg-blue-600/30'
                  }`}
                >
                  {isStartingServer ? (
                    <><div className="animate-spin h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full" /><span>Preparando...</span></>
                  ) : (
                    <span>Preparar e usar este APK</span>
                  )}
                </button>

                {localServerUrl && (
                  <p className="text-green-300 text-xs px-1">
                    ✅ Pronto! O carro vai baixar via Wi-Fi.
                  </p>
                )}
                {serverError && (
                  <p className="text-red-300 text-xs px-1">{serverError}</p>
                )}
                {!localFilePath && (
                  <p className="text-gray-500 text-xs px-1">
                    Selecione um APK baixado no seu PC. O app sobe um servidor HTTP temporário para o carro baixar via Wi-Fi.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <button
              onClick={handleContinue}
              disabled={!canContinue()}
              className={`block w-full text-white text-center py-4 px-6 rounded-xl transition-all duration-300 font-medium ${
                !canContinue()
                  ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
                  : installMode === 'clean'
                  ? 'bg-red-600 hover:bg-red-700 shadow-lg hover:shadow-red-600/30'
                  : 'bg-blue-600 hover:bg-blue-700 shadow-lg hover:shadow-blue-600/30'
              }`}
            >
              Continuar com a {installMode === 'clean' ? 'Instalação Limpa' : 'Instalação'}
            </button>
            <Link
              to="/"
              className="flex items-center justify-center gap-2 w-full bg-gray-700 text-white py-3 px-4 rounded-xl hover:bg-gray-600 transition-all duration-300 border border-gray-600"
            >
              <ArrowLeftIcon size={18} />
              <span>Voltar</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
