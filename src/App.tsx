import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BadgeCheck,
  Coins,
  ArrowLeft,
  Download,
  Landmark,
  Menu,
  Moon,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
  Trash2,
  TrendingDown,
  Upload,
  Wallet,
  X,
} from 'lucide-react'
import { createPublicClient, createWalletClient, custom, erc20Abi, formatUnits, http, parseUnits } from 'viem'
import type { Address } from 'viem'
import { celo, celoSepolia } from 'viem/chains'
import './App.css'

const CELO_MAINNET_USDT_ADDRESS = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
const CELO_SEPOLIA_USDC_ADDRESS = '0x01c5c0122039549ad1493b8220cabedd739bc44e'
const STABLE_TOKEN_DECIMALS = Number(import.meta.env.VITE_STABLE_TOKEN_DECIMALS ?? 6)
const CELO_NETWORK = import.meta.env.VITE_CELO_NETWORK === 'sepolia' ? 'sepolia' : 'mainnet'
const ACTIVE_CHAIN = CELO_NETWORK === 'sepolia' ? celoSepolia : celo
const DEFAULT_STABLE_TOKEN_SYMBOL = CELO_NETWORK === 'sepolia' ? 'USDC' : 'USDT'
const DEFAULT_STABLE_TOKEN_ADDRESS = CELO_NETWORK === 'sepolia' ? CELO_SEPOLIA_USDC_ADDRESS : CELO_MAINNET_USDT_ADDRESS
const STABLE_TOKEN_SYMBOL = import.meta.env.VITE_STABLE_TOKEN_SYMBOL ?? DEFAULT_STABLE_TOKEN_SYMBOL
const STABLE_TOKEN_ADDRESS = (import.meta.env.VITE_STABLE_TOKEN_ADDRESS ?? DEFAULT_STABLE_TOKEN_ADDRESS) as Address
const VAULT_ADDRESS = import.meta.env.VITE_VAULT_ADDRESS as Address | undefined
const BET_STORAGE_API_URL = import.meta.env.VITE_BET_STORAGE_API_URL ?? '/api/bets'
const USD_KES_RATE_FALLBACK = 129
const USD_KES_RATE_URL = 'https://open.er-api.com/v6/latest/USD'
const TEST_LOCK_SECONDS = 5 * 60

type BetStatus = 'pending' | 'won' | 'lost'
type LegPick = 'home' | 'draw' | 'away'

type BetLeg = {
  awayTeam: string
  fixture?: string
  homeTeam: string
  id: number
  odds: number
  pick: LegPick
}

type BetSlip = {
  id: number
  createdAt: number
  settledAt?: number
  legs: BetLeg[]
  platform: string
  stake: number
  status: BetStatus
}

type VaultAction = 'deposit' | 'protect' | 'withdrawBankroll' | 'unlockProtected'
type VaultMode = VaultAction | null
type AppView = 'dashboard' | 'betslips' | 'transactions'

type VaultAccount = {
  bankroll: string
  protectedSavings: string
  unlockAt: number
}

type TransactionEntry = {
  amount?: string
  createdAt: number
  hash?: string
  id: number
  label: string
  status: 'sent' | 'local'
}

type LossLimitConfig = {
  amount: number
  cycleStartedAt: number
  lockSeconds: number
}

type ExchangeRateState = {
  source: 'cached' | 'fallback' | 'live'
  updatedAt: number
  usdKes: number
}

const EDIT_WINDOW_MS = 5 * 60 * 1000
const SETTLEMENT_EDIT_WINDOW_MS = 2 * 60 * 1000
const LOSS_LIMIT_STORAGE_KEY = 'akibabet-loss-limit'
const BET_HISTORY_STORAGE_KEY = 'akibabet-bet-history'
const DEFAULT_BET_STORAGE_OWNER = 'guest'
const HISTORY_SIGNATURE_STORAGE_KEY = 'akibabet-history-signature'
const TRANSACTION_HISTORY_STORAGE_KEY = 'akibabet-transaction-history'
const EXCHANGE_RATE_STORAGE_KEY = 'akibabet-usd-kes-rate'

const platforms = ['Betika', 'Mozzart', 'SportPesa', 'Odibets']
const ADD_PLATFORM_VALUE = '__add_platform__'

function getWalletClient() {
  if (!window.ethereum) {
    throw new Error('Open this app in MiniPay or another Celo wallet.')
  }

  return createWalletClient({
    chain: ACTIVE_CHAIN,
    transport: custom(window.ethereum),
  })
}

function getPublicClient() {
  return createPublicClient({
    chain: ACTIVE_CHAIN,
    transport: http(),
  })
}

function App() {
  const entryFormRef = useRef<HTMLFormElement | null>(null)
  const backupFileRef = useRef<HTMLInputElement | null>(null)
  const [bets, setBets] = useState<BetSlip[]>(() => loadLocalBetHistory(DEFAULT_BET_STORAGE_OWNER))
  const [transactions, setTransactions] = useState<TransactionEntry[]>(() => loadTransactionHistory())
  const [legs, setLegs] = useState<BetLeg[]>([{ id: 1, awayTeam: '', homeTeam: '', odds: 1.9, pick: 'home' }])
  const [availablePlatforms, setAvailablePlatforms] = useState(platforms)
  const [platform, setPlatform] = useState(platforms[0])
  const [isAddingPlatform, setIsAddingPlatform] = useState(false)
  const [stake, setStake] = useState(200)
  const [status, setStatus] = useState<BetStatus>('pending')
  const [lossLimitConfig, setLossLimitConfig] = useState<LossLimitConfig | null>(() => loadLossLimitConfig())
  const [setupLossLimit, setSetupLossLimit] = useState(() => lossLimitConfig?.amount ?? 1500)
  const [setupLockSeconds, setSetupLockSeconds] = useState(() => lossLimitConfig?.lockSeconds ?? TEST_LOCK_SECONDS)
  const [editingBetId, setEditingBetId] = useState<number | null>(null)
  const [isBetFormOpen, setIsBetFormOpen] = useState(false)
  const [isProtectionPromptDismissed, setIsProtectionPromptDismissed] = useState(false)
  const [betFormMessage, setBetFormMessage] = useState('Deposit bankroll before logging betslips.')
  const [now, setNow] = useState(() => Date.now())
  const [wallet, setWallet] = useState<Address | null>(null)
  const [walletMessage, setWalletMessage] = useState('Wallet not connected')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (
    window.localStorage.getItem('akibabet-theme') === 'dark' ? 'dark' : 'light'
  ))
  const [vaultAccount, setVaultAccount] = useState<VaultAccount | null>(null)
  const [vaultBusy, setVaultBusy] = useState(false)
  const [vaultMode, setVaultMode] = useState<VaultMode>(null)
  const [vaultAmount, setVaultAmount] = useState(10)
  const [exchangeRate, setExchangeRate] = useState<ExchangeRateState>(() => loadExchangeRate())
  const [activeView, setActiveView] = useState<AppView>('dashboard')
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [betStorageOwner, setBetStorageOwner] = useState(DEFAULT_BET_STORAGE_OWNER)
  const [backupMessage, setBackupMessage] = useState('Connect wallet to sync betslips by wallet address.')

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('akibabet-theme', theme)
  }, [theme])

  useEffect(() => {
    saveLocalBetHistory(betStorageOwner, bets)

    if (wallet && betStorageOwner === getBetStorageOwner(wallet)) {
      void saveRemoteBetHistory(wallet, bets)
    }
  }, [betStorageOwner, bets, wallet])

  useEffect(() => {
    if (!wallet) {
      return
    }

    let cancelled = false
    const connectedWallet = wallet
    const owner = getBetStorageOwner(connectedWallet)

    async function syncWalletHistory() {
      const localBets = loadLocalBetHistory(owner)
      const remoteBets = await loadRemoteBetHistory(connectedWallet)

      if (cancelled) {
        return
      }

      setBetStorageOwner(owner)
      setBets((current) => mergeBetHistory(mergeBetHistory(current, localBets), remoteBets ?? []))
      setBackupMessage(
        remoteBets
          ? 'Betslips sync by connected wallet address.'
          : 'Wallet history is cached locally. Deploy with Netlify to enable cloud KV sync.',
      )
    }

    void syncWalletHistory()

    return () => {
      cancelled = true
    }
  }, [wallet])

  useEffect(() => {
    window.localStorage.setItem(TRANSACTION_HISTORY_STORAGE_KEY, JSON.stringify(transactions))
  }, [transactions])

  useEffect(() => {
    let cancelled = false

    async function loadUsdKesRate() {
      try {
        const response = await fetch(USD_KES_RATE_URL)
        if (!response.ok) {
          throw new Error('Rate request failed')
        }

        const data = await response.json() as { rates?: { KES?: number }, time_last_update_unix?: number }
        const usdKes = data.rates?.KES
        if (!usdKes || usdKes <= 0) {
          throw new Error('KES rate missing')
        }

        const nextRate = {
          source: 'live' as const,
          updatedAt: (data.time_last_update_unix ?? Math.floor(Date.now() / 1000)) * 1000,
          usdKes,
        }

        window.localStorage.setItem(EXCHANGE_RATE_STORAGE_KEY, JSON.stringify(nextRate))
        if (!cancelled) {
          setExchangeRate(nextRate)
        }
      } catch {
        if (!cancelled) {
          setExchangeRate((current) => current)
        }
      }
    }

    void loadUsdKesRate()

    return () => {
      cancelled = true
    }
  }, [])

  const stats = useMemo(() => {
    const settled = bets.filter((bet) => bet.status !== 'pending')
    const totalStaked = settled.reduce((sum, bet) => sum + bet.stake, 0)
    const returned = settled.reduce((sum, bet) => {
      return sum + (bet.status === 'won' ? getPotentialReturn(bet) : 0)
    }, 0)
    const net = returned - totalStaked
    const losses = settled
      .filter((bet) => bet.status === 'lost')
      .reduce((sum, bet) => sum + bet.stake, 0)
    const wins = settled.filter((bet) => bet.status === 'won').length
    const roi = totalStaked ? (net / totalStaked) * 100 : 0
    const winRate = settled.length ? (wins / settled.length) * 100 : 0

    return { losses, net, returned, roi, totalStaked, winRate }
  }, [bets])

  const lossLimit = lossLimitConfig?.amount ?? setupLossLimit
  const cycleStartedAt = lossLimitConfig?.cycleStartedAt ?? now
  const cycleStats = useMemo(() => {
    const activeSettled = bets.filter((bet) => {
      const settledAt = bet.settledAt ?? bet.createdAt
      return bet.status !== 'pending' && settledAt >= cycleStartedAt
    })
    const losses = activeSettled
      .filter((bet) => bet.status === 'lost')
      .reduce((sum, bet) => sum + bet.stake, 0)

    return { losses }
  }, [bets, cycleStartedAt])
  const lockSeconds = lossLimitConfig?.lockSeconds ?? setupLockSeconds
  const lockDurationLabel = formatLockDuration(lockSeconds)
  const hasVaultBankroll = Number(vaultAccount?.bankroll ?? 0) > 0
  const walletStatusTone = getWalletStatusTone(walletMessage)
  const requiredDeposit = getRequiredDeposit(lossLimit, exchangeRate.usdKes)
  const currentBankroll = Number(vaultAccount?.bankroll ?? 0)
  const protectedSavings = Number(vaultAccount?.protectedSavings ?? 0)
  const hasProtectedSavings = protectedSavings > 0
  const cycleLosses = hasProtectedSavings ? Math.max(cycleStats.losses, lossLimit) : cycleStats.losses
  const displayNet = stats.net
  const displayTotalStaked = stats.totalStaked
  const displayRoi = stats.roi
  const limitPercent = Math.min((cycleLosses / lossLimit) * 100, 100)
  const isLimitHit = cycleLosses >= lossLimit
  const isSavingsLocked = Boolean(vaultAccount?.unlockAt && vaultAccount.unlockAt * 1000 > now)
  const isProtectionCycleActive = hasProtectedSavings && isSavingsLocked
  const unlockRemainingMs = Math.max(0, (vaultAccount?.unlockAt ?? 0) * 1000 - now)
  const unlockTotalMs = Math.max(1, lockSeconds * 1000)
  const unlockRemainingPercent = Math.min(100, Math.max(0, (unlockRemainingMs / unlockTotalMs) * 100))
  const depositAmountDue = Math.max(0, Math.ceil((requiredDeposit - currentBankroll) * 100) / 100)
  const requiredDepositLabel = formatStableAmount(requiredDeposit)
  const depositAmountDueLabel = formatStableAmount(depositAmountDue)
  const shouldShowProtectionPrompt = isLimitHit && !hasProtectedSavings && !isProtectionPromptDismissed

  function saveMonthlyLossLimit() {
    if (setupLossLimit < 100) {
      return
    }

    const nextConfig = {
      amount: setupLossLimit,
      cycleStartedAt: Date.now(),
      lockSeconds: setupLockSeconds,
    }

    window.localStorage.setItem(LOSS_LIMIT_STORAGE_KEY, JSON.stringify(nextConfig))
    setLossLimitConfig(nextConfig)
    setIsProtectionPromptDismissed(false)
  }

  function resetMonthlyLossLimit() {
    window.localStorage.removeItem(LOSS_LIMIT_STORAGE_KEY)
    setLossLimitConfig(null)
    setSetupLossLimit(lossLimit)
    setSetupLockSeconds(lockSeconds)
    setIsProtectionPromptDismissed(false)
  }

  async function connectWallet() {
    try {
      const client = getWalletClient()
      const [account] = await client.requestAddresses()
      setWallet(account)

      const isMiniPay = Boolean(window.ethereum?.isMiniPay)
      setWalletMessage(isMiniPay ? 'MiniPay wallet connected' : 'Celo wallet connected')
      void refreshVaultAccount(account)
    } catch (error) {
      setWalletMessage(getWalletErrorMessage(error))
    }
  }

  async function handleProtectionPromptAction() {
    if (!wallet) {
      await connectWallet()
      return
    }

    await runVaultAction('protect')
  }

  async function refreshVaultAccount(account = wallet) {
    if (!account || !VAULT_ADDRESS) {
      setVaultAccount(null)
      return
    }

    try {
      const client = getPublicClient()
      const result = await client.readContract({
        address: VAULT_ADDRESS,
        abi: [
          {
            inputs: [{ internalType: 'address', name: '', type: 'address' }],
            name: 'accounts',
            outputs: [
              { internalType: 'uint256', name: 'bankroll', type: 'uint256' },
              { internalType: 'uint256', name: 'protectedSavings', type: 'uint256' },
              { internalType: 'uint256', name: 'unlockAt', type: 'uint256' },
              { internalType: 'uint256', name: 'monthlyLossLimit', type: 'uint256' },
              { internalType: 'uint256', name: 'lockSeconds', type: 'uint256' },
            ],
            stateMutability: 'view',
            type: 'function',
          },
        ],
        functionName: 'accounts',
        args: [account],
      })
      const [bankroll, protectedSavings, unlockAt] = result

      setVaultAccount({
        bankroll: Number(formatUnits(bankroll, STABLE_TOKEN_DECIMALS)).toFixed(2),
        protectedSavings: Number(formatUnits(protectedSavings, STABLE_TOKEN_DECIMALS)).toFixed(2),
        unlockAt: Number(unlockAt),
      })
    } catch {
      setVaultAccount(null)
    }
  }

  async function runVaultAction(action: VaultAction) {
    if (vaultBusy) {
      return
    }

    if (!VAULT_ADDRESS) {
      setWalletMessage('Set VITE_VAULT_ADDRESS after deploying the vault.')
      return
    }

    try {
      setVaultBusy(true)
      const client = getWalletClient()
      const publicClient = getPublicClient()
      const [account] = await client.requestAddresses()
      const amountValue = action === 'deposit' ? depositAmountDue : vaultAmount
      if (amountValue <= 0) {
        setWalletMessage('Monthly bankroll limit is already funded.')
        return
      }

      const amount = parseUnits(String(amountValue), STABLE_TOKEN_DECIMALS)

      if (action === 'deposit') {
        setWalletMessage(`Approving ${STABLE_TOKEN_SYMBOL} spend...`)
        const approvalHash = await client.writeContract({
          account,
          address: STABLE_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [VAULT_ADDRESS, amount],
        })
        setWalletMessage(`Approval sent: ${approvalHash.slice(0, 10)}... waiting for confirmation.`)
        await publicClient.waitForTransactionReceipt({ hash: approvalHash })

        setWalletMessage(`Depositing ${STABLE_TOKEN_SYMBOL} into vault...`)
        const hash = await client.writeContract({
          account,
          address: VAULT_ADDRESS,
          abi: [
            {
              inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
              name: 'deposit',
              outputs: [],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ],
          functionName: 'deposit',
          args: [amount],
        })

      setWallet(account)
      setWalletMessage(`Vault transaction sent: ${hash.slice(0, 10)}...`)
      recordTransaction('Deposit to Akiba Vault', hash, `${formatStableAmount(amountValue)} ${STABLE_TOKEN_SYMBOL}`)
      void refreshVaultAccount(account)
      setIsProtectionPromptDismissed(true)
      setVaultMode(null)
      return
      }

      if (action === 'withdrawBankroll') {
        setWalletMessage(`Withdrawing available ${STABLE_TOKEN_SYMBOL} bankroll...`)
        const hash = await client.writeContract({
          account,
          address: VAULT_ADDRESS,
          abi: [
            {
              inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
              name: 'withdrawBankroll',
              outputs: [],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ],
          functionName: 'withdrawBankroll',
          args: [amount],
        })

        setWallet(account)
        setWalletMessage(`Withdraw transaction sent: ${hash.slice(0, 10)}...`)
        recordTransaction('Withdraw bankroll', hash, `${formatStableAmount(amountValue)} ${STABLE_TOKEN_SYMBOL}`)
        void refreshVaultAccount(account)
        setVaultMode(null)
        return
      }

      if (action === 'protect') {
        setWalletMessage('Saving protection rules...')
        const rulesHash = await client.writeContract({
          account,
          address: VAULT_ADDRESS,
          abi: [
            {
              inputs: [
                { internalType: 'uint256', name: 'monthlyLossLimit', type: 'uint256' },
                { internalType: 'uint256', name: 'lockSeconds', type: 'uint256' },
              ],
              name: 'setProtectionRulesSeconds',
              outputs: [],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ],
          functionName: 'setProtectionRulesSeconds',
          args: [0n, BigInt(lockSeconds)],
        })
        await publicClient.waitForTransactionReceipt({ hash: rulesHash })
      }

      setWalletMessage(action === 'protect' ? 'Moving bankroll into protected savings...' : 'Unlocking protected savings to bankroll...')
      const hash = await client.writeContract({
        account,
        address: VAULT_ADDRESS,
        abi: [
          {
            inputs: [],
            name: action === 'protect' ? 'protectBalance' : 'unlockProtectedToBankroll',
            outputs: [],
            stateMutability: 'nonpayable',
            type: 'function',
          },
        ],
        functionName: action === 'protect' ? 'protectBalance' : 'unlockProtectedToBankroll',
      })

      setWallet(account)
      setWalletMessage(`Vault transaction sent: ${hash.slice(0, 10)}...`)
      if (action === 'unlockProtected') {
        await publicClient.waitForTransactionReceipt({ hash })
        window.localStorage.removeItem(LOSS_LIMIT_STORAGE_KEY)
        setLossLimitConfig(null)
        setSetupLossLimit(lossLimit)
        setSetupLockSeconds(lockSeconds)
        setIsProtectionPromptDismissed(false)
        setBetFormMessage('Set a new loss limit before logging more betslips.')
      }
      recordTransaction(
        action === 'protect' ? 'Lock funds to vault' : 'Unlock to bankroll',
        hash,
        action === 'protect' ? undefined : `${vaultAccount?.protectedSavings ?? '--'} ${STABLE_TOKEN_SYMBOL}`,
      )
      void refreshVaultAccount(account)
      setVaultMode(null)
    } catch (error) {
      setWalletMessage(getVaultErrorMessage(error))
    } finally {
      setVaultBusy(false)
    }
  }

  function addBet() {
    if (isProtectionCycleActive && !editingBetId) {
      setBetFormMessage('Betslip logging is paused while protected savings are locked.')
      return
    }

    if (!hasVaultBankroll && !editingBetId) {
      setBetFormMessage('Deposit bankroll into the vault before logging a new betslip.')
      return
    }

    const cleanedLegs = legs
      .filter((leg) => getHomeTeam(leg).trim() && getAwayTeam(leg).trim() && leg.odds > 1)
      .map((leg) => ({
        ...leg,
        awayTeam: getAwayTeam(leg).trim(),
        fixture: undefined,
        homeTeam: getHomeTeam(leg).trim(),
        pick: leg.pick ?? 'home',
      }))

    if (!cleanedLegs.length || stake <= 0) {
      setBetFormMessage('Add at least one game and a valid stake.')
      return
    }

    if (editingBetId) {
      setBets((current) => current.map((bet) => (
        bet.id === editingBetId
          ? { ...bet, legs: cleanedLegs, platform, stake, status }
          : bet
      )))
      setEditingBetId(null)
    } else {
      setBets((current) => [
        {
          id: Date.now(),
          createdAt: Date.now(),
          legs: cleanedLegs,
          platform,
          stake,
          status,
        },
        ...current,
      ])
    }

    setLegs([{ id: Date.now() + 1, awayTeam: '', homeTeam: '', odds: 1.9, pick: 'home' }])
    setStake(200)
    setStatus('pending')
    setBetFormMessage('Betslip saved.')
    setIsBetFormOpen(false)
  }

  function recordTransaction(label: string, hash?: string, amount?: string) {
    setTransactions((current) => [
      {
        amount,
        createdAt: Date.now(),
        hash,
        id: Date.now(),
        label,
        status: hash ? 'sent' as const : 'local' as const,
      },
      ...current,
    ].slice(0, 30))
  }

  function exportBetHistory() {
    const payload = JSON.stringify({
      app: 'AkibaBet',
      bets,
      createdAt: new Date().toISOString(),
      version: 1,
    }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `akibabet-bets-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setBackupMessage('Backup exported. Keep that file so you can restore this history later.')
  }

  async function importBetHistory(file?: File) {
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as { bets?: BetSlip[] }
      const importedBets = sanitizeBetHistory(parsed.bets)

      if (!importedBets.length) {
        setBackupMessage('No valid betslips found in that backup file.')
        return
      }

      setBets((current) => mergeBetHistory(current, importedBets))
      setBackupMessage(`Restored ${importedBets.length} betslip${importedBets.length === 1 ? '' : 's'} from backup.`)
    } catch {
      setBackupMessage('Backup restore failed. Choose a valid AkibaBet backup file.')
    } finally {
      if (backupFileRef.current) {
        backupFileRef.current.value = ''
      }
    }
  }

  function updateLeg(id: number, patch: Partial<BetLeg>) {
    setLegs((current) => current.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)))
  }

  function addLeg() {
    setLegs((current) => [...current, { id: Date.now(), awayTeam: '', homeTeam: '', odds: 1.9, pick: 'home' }])
  }

  function removeLeg(id: number) {
    setLegs((current) => current.length === 1 ? current : current.filter((leg) => leg.id !== id))
  }

  function updateBetStatus(id: number, nextStatus: BetStatus) {
    setBets((current) => current.map((bet) => {
      if (bet.id !== id) {
        return bet
      }

      if (bet.status === nextStatus) {
        return bet
      }

      return {
        ...bet,
        settledAt: nextStatus === 'pending' ? undefined : Date.now(),
        status: nextStatus,
      }
    }))
  }

  function editBet(bet: BetSlip) {
    if (!canEditSlip(bet, now)) {
      return
    }

    setEditingBetId(bet.id)
    setLegs(bet.legs.map((leg) => ({
      ...leg,
      awayTeam: getAwayTeam(leg),
      homeTeam: getHomeTeam(leg),
      pick: leg.pick ?? 'home',
    })))
    setPlatform(bet.platform)
    setIsAddingPlatform(false)
    setStake(bet.stake)
    setStatus(bet.status)
    setIsBetFormOpen(true)

    if (!availablePlatforms.includes(bet.platform)) {
      setAvailablePlatforms((current) => [...current, bet.platform])
    }

    window.setTimeout(() => {
      entryFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  function cancelEdit() {
    setEditingBetId(null)
    setIsBetFormOpen(false)
    setLegs([{ id: Date.now() + 1, awayTeam: '', homeTeam: '', odds: 1.9, pick: 'home' }])
    setStake(200)
    setStatus('pending')
  }

  function saveCustomPlatform(value: string) {
    const cleaned = value.trim()

    if (!cleaned) {
      return
    }

    setAvailablePlatforms((current) => {
      const existing = current.find((item) => item.toLowerCase() === cleaned.toLowerCase())
      if (existing) {
        setPlatform(existing)
        return current
      }

      setPlatform(cleaned)
      return [...current, cleaned]
    })
    setIsAddingPlatform(false)
  }

  function handlePlatformChange(value: string) {
    if (value === ADD_PLATFORM_VALUE) {
      setPlatform('')
      setIsAddingPlatform(true)
      return
    }

    setPlatform(value)
    setIsAddingPlatform(false)
  }

  function openView(view: AppView) {
    setActiveView(view)
    setIsMenuOpen(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  if (!lossLimitConfig) {
    return (
      <main className="setupShell">
        <section className="setupPanel">
          <div>
            <p className="eyebrow">AkibaBet</p>
            <h1>Track the truth before the next slip.</h1>
            <p>
              Log your betslips, see real profit and loss, and protect remaining
              bankroll when your loss limit is reached.
            </p>
          </div>
          <div className="setupForm">
            <label>
              Loss limit KES
              <input
                type="number"
                min="100"
                value={setupLossLimit}
                onChange={(event) => setSetupLossLimit(Number(event.target.value))}
              />
            </label>
            <label>
              Funds lock duration
              <select value={setupLockSeconds} onChange={(event) => setSetupLockSeconds(Number(event.target.value))}>
                <option value={TEST_LOCK_SECONDS}>5 minutes (testing)</option>
                <option value={7 * 24 * 60 * 60}>7 days</option>
                <option value={14 * 24 * 60 * 60}>14 days</option>
                <option value={30 * 24 * 60 * 60}>30 days</option>
              </select>
            </label>
            <div className="monthLockPreview">
              <strong>{formatKes(setupLossLimit)}</strong>
              <span>After this loss limit is hit, remaining bankroll locks for {formatLockDuration(setupLockSeconds)}.</span>
            </div>
            <button className="primaryButton" type="button" onClick={saveMonthlyLossLimit}>
              Start tracking
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="topbarLead">
          <button
            className="menuButton"
            type="button"
            onClick={() => setIsMenuOpen(true)}
            title="Open menu"
          >
            <Menu size={20} />
          </button>
          <div className="brandBlock">
          <div className="brandMark">A</div>
          <div>
            <h1>AkibaBet</h1>
            <span className="brandSubtitle">Betslip truth tracker</span>
          </div>
          </div>
        </div>
        <div className="topActions">
          <button
            className="themeButton"
            type="button"
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            title="Toggle theme"
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button
            className={wallet ? 'iconButton compactWalletButton' : 'iconButton'}
            type="button"
            onClick={connectWallet}
            title="Connect wallet"
          >
            <Wallet size={18} />
            <span>{wallet ? 'Connected' : 'Connect'}</span>
          </button>
        </div>
      </header>

      {isMenuOpen && (
        <div className="menuOverlay" role="presentation" onClick={() => setIsMenuOpen(false)}>
          <nav className="sideMenu" aria-label="AkibaBet menu" onClick={(event) => event.stopPropagation()}>
            <div className="sideMenuHeader">
              <strong>Menu</strong>
              <button type="button" onClick={() => setIsMenuOpen(false)} title="Close menu">
                <X size={18} />
              </button>
            </div>
            <button type="button" className={activeView === 'dashboard' ? 'active' : ''} onClick={() => openView('dashboard')}>
              <ShieldCheck size={18} />
              Dashboard
            </button>
            <button type="button" className={activeView === 'betslips' ? 'active' : ''} onClick={() => openView('betslips')}>
              <TrendingDown size={18} />
              Betslip history
            </button>
            <button type="button" className={activeView === 'transactions' ? 'active' : ''} onClick={() => openView('transactions')}>
              <Coins size={18} />
              Transaction history
            </button>
          </nav>
        </div>
      )}

      {activeView === 'dashboard' ? (
      <>
      <section className="heroPanel">
        <div className="heroCopy">
          <p className="eyebrow">Betting tracker + bankroll protection</p>
          <h2>See the real ROI before emotion spends the rest.</h2>
          <p>
            Track every betslip from Kenyan betting platforms, face the real profit/loss,
            and move protected {STABLE_TOKEN_SYMBOL} into a time-locked savings vault.
          </p>
        </div>
        <div className={isLimitHit ? 'limitCard danger' : 'limitCard'}>
          <ShieldCheck size={22} />
          <span>Loss limit</span>
          <strong>{formatKes(cycleLosses)} / {formatKes(lossLimit)}</strong>
          <div className="progressTrack">
            <span style={{ width: `${limitPercent}%` }} />
          </div>
          <small>Funds lock for {lockDurationLabel} after limit is hit</small>
          <small>{isLimitHit ? 'Protection triggered' : 'Still below your limit'}</small>
          <button className="resetLimitButton" type="button" onClick={resetMonthlyLossLimit}>
            {hasProtectedSavings && !isSavingsLocked ? 'Set new limit' : 'Change limit'}
          </button>
        </div>
      </section>

      <section className="metricsGrid">
        <Metric label="Net position" value={formatKes(displayNet)} tone={displayNet < 0 ? 'bad' : 'good'} />
        <Metric label="Real ROI" value={`${displayRoi.toFixed(1)}%`} tone={displayRoi < 0 ? 'bad' : 'good'} />
        <Metric label="Total staked" value={formatKes(displayTotalStaked)} />
        <Metric label="Win rate" value={`${stats.winRate.toFixed(0)}%`} />
      </section>

      <section className="workspace">
        <form
          ref={entryFormRef}
          className={[
            'entryPanel',
            editingBetId ? 'editing' : '',
            isBetFormOpen || editingBetId ? 'open' : 'collapsed',
          ].filter(Boolean).join(' ')}
          onSubmit={(event) => { event.preventDefault(); addBet() }}
        >
          <button
            className="entryToggle"
            type="button"
            onClick={() => setIsBetFormOpen((current) => !current)}
          >
            <span className="entryToggleMain">
              <span className="entryToggleIcon">
                <Plus size={18} />
              </span>
              <span className="entryToggleCopy">
                <strong>{editingBetId ? 'Edit betslip' : 'Log a betslip'}</strong>
                <small>Games, picks, odds, stake, result</small>
              </span>
            </span>
            <strong className="entryToggleAction">{isBetFormOpen || editingBetId ? 'Close' : 'Open'}</strong>
          </button>
          {(isBetFormOpen || editingBetId) && (
            <>
              {editingBetId && (
                <div className="editNotice">
                  <strong>Editing open</strong>
                  <span>Games, odds, stake, platform, and result can be changed.</span>
                </div>
              )}
              {isProtectionCycleActive && !editingBetId && (
                <div className="bankrollGateNotice">
                  <strong>Take a break</strong>
                  <span>Your bankroll is locked. Betslip logging resumes after protected savings unlock.</span>
                </div>
              )}
              {!isProtectionCycleActive && !hasVaultBankroll && !editingBetId && (
                <div className="bankrollGateNotice">
                  <strong>Bankroll required</strong>
                  <span>Connect MiniPay and deposit into the vault before logging betslips.</span>
                </div>
              )}
              <div className="legsEditor">
                {legs.map((leg, index) => (
                  <div className="legInput" key={leg.id}>
                <label>
                  Game {index + 1} home
                  <input
                    value={getHomeTeam(leg)}
                    onChange={(event) => updateLeg(leg.id, { homeTeam: event.target.value })}
                    placeholder="Kenya"
                  />
                </label>
                <span className="versusText">vs</span>
                <label>
                  Away
                  <input
                    value={getAwayTeam(leg)}
                    onChange={(event) => updateLeg(leg.id, { awayTeam: event.target.value })}
                    placeholder="Uganda"
                  />
                </label>
                <label>
                  Pick
                  <select
                    value={leg.pick ?? 'home'}
                    onChange={(event) => updateLeg(leg.id, { pick: event.target.value as LegPick })}
                  >
                    <option value="home">Home win</option>
                    <option value="draw">Draw</option>
                    <option value="away">Away win</option>
                  </select>
                </label>
                <label>
                  Odds
                  <input
                    type="number"
                    min="1.01"
                    step="0.01"
                    value={leg.odds}
                    onChange={(event) => updateLeg(leg.id, { odds: Number(event.target.value) })}
                  />
                </label>
                <button
                  className="smallIconButton"
                  type="button"
                  onClick={() => removeLeg(leg.id)}
                  title="Remove game"
                >
                  <Trash2 size={16} />
                </button>
                  </div>
                ))}
                <button className="secondaryButton" type="button" onClick={addLeg}>
                  <Plus size={16} />
                  Add another game
                </button>
              </div>
              <div className="fieldPair">
                <label>
                  Platform
                  {isAddingPlatform ? (
                    <input
                      autoFocus
                      value={platform}
                      onBlur={(event) => saveCustomPlatform(event.target.value)}
                      onChange={(event) => setPlatform(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          saveCustomPlatform(platform)
                        }
                      }}
                      placeholder="Type platform"
                    />
                  ) : (
                    <select value={platform} onChange={(event) => handlePlatformChange(event.target.value)}>
                      {availablePlatforms.map((item) => <option key={item}>{item}</option>)}
                      <option value={ADD_PLATFORM_VALUE}>Add platform</option>
                    </select>
                  )}
                </label>
                <label>
                  Status
                  <select value={status} onChange={(event) => setStatus(event.target.value as BetStatus)}>
                    <option value="pending">Pending</option>
                    <option value="won">Won</option>
                    <option value="lost">Lost</option>
                  </select>
                </label>
              </div>
              <label>
                Betslip stake KES
                <input type="number" min="1" value={stake} onChange={(event) => setStake(Number(event.target.value))} />
              </label>
              <button className="primaryButton" type="submit" disabled={(!hasVaultBankroll || isProtectionCycleActive) && !editingBetId}>
                <Plus size={18} />
                {editingBetId ? 'Save betslip' : 'Log a betslip'}
              </button>
              <p className="formMessage">{betFormMessage}</p>
              {editingBetId && (
                <button className="secondaryButton cancelEditButton" type="button" onClick={cancelEdit}>
                  Cancel edit
                </button>
              )}
            </>
          )}
        </form>

        <div className="vaultPanel">
          <div className="sectionHeader">
            <div>
              <Landmark size={18} />
              <h3>{STABLE_TOKEN_SYMBOL} bankroll vault</h3>
            </div>
            <button
              className="refreshVaultButton"
              type="button"
              disabled={vaultBusy || !wallet}
              onClick={() => refreshVaultAccount()}
              title="Refresh vault"
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
          <div className={`walletStatus ${walletStatusTone}`}>
            <BadgeCheck size={18} />
            <span>{walletMessage}</span>
          </div>
          <div className="vaultBalanceGrid">
            <article>
              <span>Available bankroll</span>
              <strong>{vaultAccount?.bankroll ?? '--'} {STABLE_TOKEN_SYMBOL}</strong>
            </article>
            <article>
              <span>Protected savings</span>
              <strong>{vaultAccount?.protectedSavings ?? '--'} {STABLE_TOKEN_SYMBOL}</strong>
            </article>
          </div>
          <p className="helperText">
            Deposit funds the tracked bankroll. Withdraw bankroll sends available funds back to MiniPay.
            Protected savings unlock after the lock period.
          </p>
          {hasProtectedSavings && (
            <div className={isSavingsLocked ? 'savingsLockStatus locked' : 'savingsLockStatus unlocked'}>
              <strong>{isSavingsLocked ? 'Protected savings locked' : 'Protected savings unlocked'}</strong>
              <span>
                {isSavingsLocked
                  ? `Unlocks in ${formatLockCountdown(unlockRemainingMs)}.`
                  : 'You can unlock protected savings back into bankroll now.'}
              </span>
              {isSavingsLocked && (
                <p className="breakMessage">
                  Take a break from betting while your funds are protected. Step away, review your slips, and come back only when you are calm.
                </p>
              )}
              {isSavingsLocked && (
                <div className="unlockProgress">
                  <div>
                    <span style={{ width: `${unlockRemainingPercent}%` }} />
                  </div>
                  <small>{formatLockCountdown(unlockRemainingMs)} remaining</small>
                </div>
              )}
            </div>
          )}
          {isLimitHit && !hasProtectedSavings && isProtectionPromptDismissed && (
            <div className="protectionRetry">
              <span>Loss limit hit. Lock remaining bankroll for {lockDurationLabel}.</span>
              <button type="button" disabled={vaultBusy} onClick={() => setIsProtectionPromptDismissed(false)}>
                Lock funds
              </button>
            </div>
          )}
          {isProtectionCycleActive && (
            <div className="protectionPause">
              <strong>Bankroll paused</strong>
              <span>Deposits, withdrawals, and new betslips are paused until protected savings unlock.</span>
            </div>
          )}
          {!isProtectionCycleActive && (
          <div className="vaultActions">
            <div className="vaultActionItem">
              <button type="button" disabled={vaultBusy} onClick={() => setVaultMode(vaultMode === 'deposit' ? null : 'deposit')}>
                <Coins size={18} />
                Deposit to Akiba Vault
              </button>
              {vaultMode === 'deposit' && (
                <div className="vaultModePanel">
                  <div className="vaultModeHeader">
                    <strong>Deposit to vault</strong>
                    <span>Funds move from MiniPay to your tracked bankroll.</span>
                  </div>
                  <div className="depositSummary">
                    <span>Loss limit</span>
                    <strong>{formatKes(lossLimit)}</strong>
                    <span>Required deposit</span>
                    <strong>{requiredDepositLabel} {STABLE_TOKEN_SYMBOL}</strong>
                    <span>Deposit now</span>
                    <strong>{depositAmountDueLabel} {STABLE_TOKEN_SYMBOL}</strong>
                    <small>
                      1 {STABLE_TOKEN_SYMBOL} = Ksh {exchangeRate.usdKes.toFixed(2)}
                      {exchangeRate.source === 'fallback' ? ' estimate' : ''}
                    </small>
                    <small>Rate source: ExchangeRate-API</small>
                  </div>
                  <div className="vaultModeActions">
                    <button type="button" disabled={vaultBusy || depositAmountDue <= 0} onClick={() => runVaultAction('deposit')}>
                      {vaultBusy ? 'Working...' : depositAmountDue <= 0 ? 'Limit funded' : getVaultModeLabel('deposit')}
                    </button>
                    <button type="button" disabled={vaultBusy} onClick={() => setVaultMode(null)}>
                      Cancel
                    </button>
                  </div>
                  <p className={`vaultInlineMessage ${walletStatusTone}`}>{walletMessage}</p>
                </div>
              )}
            </div>
            <div className="vaultActionItem">
              <button type="button" disabled={vaultBusy || isLimitHit} onClick={() => setVaultMode(vaultMode === 'withdrawBankroll' ? null : 'withdrawBankroll')}>
                <Coins size={18} />
                Withdraw bankroll
              </button>
              {vaultMode === 'withdrawBankroll' && (
                <div className="vaultModePanel">
                  <div className="vaultModeHeader">
                    <strong>Withdraw bankroll</strong>
                    <span>Available bankroll returns to your MiniPay wallet.</span>
                  </div>
                  <label>
                    Amount {STABLE_TOKEN_SYMBOL}
                    <input type="number" min="1" value={vaultAmount} onChange={(event) => setVaultAmount(Number(event.target.value))} />
                  </label>
                  <div className="vaultModeActions">
                    <button type="button" disabled={vaultBusy} onClick={() => runVaultAction('withdrawBankroll')}>
                      {vaultBusy ? 'Working...' : getVaultModeLabel('withdrawBankroll')}
                    </button>
                    <button type="button" disabled={vaultBusy} onClick={() => setVaultMode(null)}>
                      Cancel
                    </button>
                  </div>
                  <p className={`vaultInlineMessage ${walletStatusTone}`}>{walletMessage}</p>
                </div>
              )}
            </div>
            {hasProtectedSavings && !isSavingsLocked && (
            <div className="vaultActionItem">
              <button type="button" disabled={vaultBusy} onClick={() => setVaultMode(vaultMode === 'unlockProtected' ? null : 'unlockProtected')}>
                <Coins size={18} />
                Unlock to bankroll
              </button>
              {vaultMode === 'unlockProtected' && (
                <div className="vaultModePanel">
                  <div className="vaultModeHeader">
                    <strong>Unlock to bankroll</strong>
                    <span>Protected savings become available bankroll again.</span>
                  </div>
                  <div className="vaultModeActions">
                    <button type="button" disabled={vaultBusy} onClick={() => runVaultAction('unlockProtected')}>
                      {vaultBusy ? 'Working...' : getVaultModeLabel('unlockProtected')}
                    </button>
                    <button type="button" disabled={vaultBusy} onClick={() => setVaultMode(null)}>
                      Cancel
                    </button>
                  </div>
                  <p className={`vaultInlineMessage ${walletStatusTone}`}>{walletMessage}</p>
                </div>
              )}
            </div>
            )}
          </div>
          )}
          <div className="contractBox">
            <span>Vault contract</span>
            <strong>{VAULT_ADDRESS ?? 'Deploy then set VITE_VAULT_ADDRESS'}</strong>
          </div>
        </div>
      </section>

      {shouldShowProtectionPrompt && (
        <div className="protectionOverlay" role="dialog" aria-modal="true" aria-labelledby="protection-title">
          <div className="protectionDialog">
            <div className="protectionDialogIcon">
              <Lock size={24} />
            </div>
            <p className="eyebrow">Protection required</p>
            <h3 id="protection-title">Loss limit hit</h3>
            <p>
              You have reached your loss limit. Lock remaining bankroll for {lockDurationLabel}{' '}
              to avoid further losses.
            </p>
            <p className={`protectionDialogStatus ${walletStatusTone}`}>{walletMessage}</p>
            <div className="protectionDialogActions">
              <button type="button" disabled={vaultBusy} onClick={handleProtectionPromptAction}>
                {vaultBusy ? 'Locking...' : wallet ? 'Lock funds to vault' : 'Connect MiniPay first'}
              </button>
              <button type="button" disabled={vaultBusy} onClick={() => setIsProtectionPromptDismissed(true)}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
      </>
      ) : activeView === 'betslips' ? (
      <section className="historyPage">
        <div className="sectionHeader">
          <button className="backButton" type="button" onClick={() => openView('dashboard')}>
            <ArrowLeft size={16} />
          </button>
          <div>
            <TrendingDown size={18} />
            <h3>Betslip history</h3>
          </div>
        </div>
        <div className="historyBackup">
          <div>
            <strong>Wallet history</strong>
            <span>{backupMessage}</span>
          </div>
          <div className="historyBackupActions">
            <button type="button" onClick={exportBetHistory} disabled={bets.length === 0}>
              <Download size={16} />
              Export
            </button>
            <button type="button" onClick={() => backupFileRef.current?.click()}>
              <Upload size={16} />
              Restore
            </button>
          </div>
          <input
            ref={backupFileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => void importBetHistory(event.target.files?.[0])}
          />
        </div>
        {bets.length === 0 && (
          <div className="emptyHistory">
            <strong>No betslips yet</strong>
            <span>Deposit bankroll, then add your first slip.</span>
          </div>
        )}
        {bets.map((bet) => (
          <article className="ticket" key={bet.id}>
            <div>
              <strong>{bet.platform} betslip</strong>
              <span>{bet.legs.length} games - combined odds {getCombinedOdds(bet.legs).toFixed(2)}</span>
              <ul className="legList">
                {bet.legs.map((leg) => (
                  <li key={leg.id}>
                    <span>
                      {getFixtureLabel(leg)}
                      <small>{getPickLabel(leg)}</small>
                    </span>
                    <strong>{leg.odds.toFixed(2)}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <strong>{formatKes(bet.stake)}</strong>
              <span>Possible return {formatKes(getPotentialReturn(bet))}</span>
              <label className="statusEditor">
                Result
                <select
                  className={`statusSelect ${bet.status}`}
                  disabled={!canEditResult(bet, now)}
                  value={bet.status}
                  onChange={(event) => updateBetStatus(bet.id, event.target.value as BetStatus)}
                >
                  <option value="pending">Pending</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
              </label>
              {canEditSlip(bet, now) && (
                <button
                  className="secondaryButton editSlipButton"
                  type="button"
                  onClick={() => editBet(bet)}
                >
                  Edit {formatRemainingEditTime(bet, now)}
                </button>
              )}
            </div>
          </article>
        ))}
      </section>
      ) : (
      <section className="historyPage">
        <div className="sectionHeader">
          <button className="backButton" type="button" onClick={() => openView('dashboard')}>
            <ArrowLeft size={16} />
          </button>
          <div>
            <Coins size={18} />
            <h3>Transaction history</h3>
          </div>
        </div>
        {transactions.length === 0 && (
          <div className="emptyHistory">
            <strong>No vault transactions yet</strong>
            <span>Deposits, locks, and withdrawals will appear here.</span>
          </div>
        )}
        {transactions.map((transaction) => (
          <article className="transactionItem" key={transaction.id}>
            <div>
              <strong>{transaction.label}</strong>
              <span>{formatHistoryTime(transaction.createdAt)}</span>
              {transaction.amount && <small>{transaction.amount}</small>}
            </div>
            {transaction.hash && <code>{shortHash(transaction.hash)}</code>}
          </article>
        ))}
      </section>
      )}
    </main>
  )
}

function getCombinedOdds(legs: BetLeg[]) {
  return legs.reduce((product, leg) => product * leg.odds, 1)
}

function getPotentialReturn(bet: BetSlip) {
  return bet.stake * getCombinedOdds(bet.legs)
}

function getHomeTeam(leg: BetLeg) {
  return leg.homeTeam || leg.fixture?.split(/\s+vs\s+/i)[0] || ''
}

function getAwayTeam(leg: BetLeg) {
  return leg.awayTeam || leg.fixture?.split(/\s+vs\s+/i)[1] || ''
}

function getFixtureLabel(leg: BetLeg) {
  return `${getHomeTeam(leg)} vs ${getAwayTeam(leg)}`
}

function getPickLabel(leg: BetLeg) {
  if (leg.pick === 'draw') {
    return 'Pick: Draw'
  }

  if (leg.pick === 'away') {
    return `Pick: ${getAwayTeam(leg)} win`
  }

  return `Pick: ${getHomeTeam(leg)} win`
}

function getBetStorageOwner(wallet?: Address | null) {
  return wallet ? `wallet:${wallet.toLowerCase()}` : DEFAULT_BET_STORAGE_OWNER
}

function getBetStorageKey(owner: string) {
  return `${BET_HISTORY_STORAGE_KEY}:${owner}`
}

function loadLocalBetHistory(owner: string) {
  try {
    const raw = window.localStorage.getItem(getBetStorageKey(owner))
      ?? (owner === DEFAULT_BET_STORAGE_OWNER ? window.localStorage.getItem(BET_HISTORY_STORAGE_KEY) : null)
    if (!raw) {
      return []
    }

    return sanitizeBetHistory(JSON.parse(raw))
  } catch {
    return []
  }
}

function saveLocalBetHistory(owner: string, bets: BetSlip[]) {
  window.localStorage.setItem(getBetStorageKey(owner), JSON.stringify(bets))
}

async function loadRemoteBetHistory(wallet: Address) {
  try {
    const signature = await getHistorySignature(wallet)
    const response = await fetch(`${BET_STORAGE_API_URL}?wallet=${wallet}`, {
      headers: { 'x-akibabet-signature': signature },
    })
    if (!response.ok) {
      throw new Error('Remote history unavailable')
    }

    const payload = await response.json() as { bets?: unknown[] }
    return sanitizeBetHistory(payload.bets)
  } catch {
    return null
  }
}

async function saveRemoteBetHistory(wallet: Address, bets: BetSlip[]) {
  try {
    const signature = await getHistorySignature(wallet)
    await fetch(`${BET_STORAGE_API_URL}?wallet=${wallet}`, {
      body: JSON.stringify({ bets }),
      headers: {
        'Content-Type': 'application/json',
        'x-akibabet-signature': signature,
      },
      method: 'PUT',
    })
  } catch {
    // Local cache remains the fallback while the KV backend is unavailable.
  }
}

async function getHistorySignature(wallet: Address) {
  const key = `${HISTORY_SIGNATURE_STORAGE_KEY}:${wallet.toLowerCase()}`
  const cached = window.localStorage.getItem(key)
  if (cached) {
    return cached
  }

  const client = getWalletClient()
  const signature = await client.signMessage({
    account: wallet,
    message: getHistorySyncMessage(wallet),
  })
  window.localStorage.setItem(key, signature)
  return signature
}

function getHistorySyncMessage(wallet: Address | string) {
  return `AkibaBet history sync\nWallet: ${wallet.toLowerCase()}`
}

function sanitizeBetHistory(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((bet): bet is BetSlip => {
      return Boolean(
        bet &&
        typeof bet === 'object' &&
        Array.isArray((bet as BetSlip).legs) &&
        typeof (bet as BetSlip).stake === 'number',
      )
    })
    .map((bet) => ({
      ...bet,
      createdAt: bet.createdAt || Date.now(),
      id: bet.id || Date.now(),
      legs: bet.legs.map((leg) => ({
        ...leg,
        awayTeam: getAwayTeam(leg),
        homeTeam: getHomeTeam(leg),
        id: leg.id || Date.now(),
        odds: Number(leg.odds) || 1.01,
        pick: leg.pick ?? 'home',
      })),
      status: bet.status ?? 'pending',
    }))
}

function mergeBetHistory(current: BetSlip[], importedBets: BetSlip[]) {
  const existingIds = new Set(current.map((bet) => bet.id))
  const uniqueImported = importedBets.filter((bet) => !existingIds.has(bet.id))

  return [...uniqueImported, ...current].sort((a, b) => b.createdAt - a.createdAt)
}

function loadTransactionHistory() {
  try {
    const raw = window.localStorage.getItem(TRANSACTION_HISTORY_STORAGE_KEY)
    if (!raw) {
      return []
    }

    const parsed = JSON.parse(raw) as TransactionEntry[]
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter((item) => item && item.id && item.label && item.createdAt).slice(0, 30)
  } catch {
    return []
  }
}

function loadLossLimitConfig(): LossLimitConfig | null {
  try {
    const raw = window.localStorage.getItem(LOSS_LIMIT_STORAGE_KEY)
    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as Partial<LossLimitConfig> & { lockDays?: number, monthKey?: string }
    if (!parsed.amount) {
      return null
    }

    return {
      amount: parsed.amount,
      cycleStartedAt: parsed.cycleStartedAt ?? Date.now(),
      lockSeconds: normalizeLockSeconds(parsed.lockSeconds, parsed.lockDays),
    }
  } catch {
    return null
  }
}

function loadExchangeRate(): ExchangeRateState {
  try {
    const raw = window.localStorage.getItem(EXCHANGE_RATE_STORAGE_KEY)
    if (!raw) {
      throw new Error('No cached rate')
    }

    const parsed = JSON.parse(raw) as ExchangeRateState
    if (!parsed.usdKes || parsed.usdKes <= 0) {
      throw new Error('Invalid cached rate')
    }

    return { ...parsed, source: 'cached' }
  } catch {
    return {
      source: 'fallback',
      updatedAt: Date.now(),
      usdKes: USD_KES_RATE_FALLBACK,
    }
  }
}

function getRequiredDeposit(lossLimitKes: number, usdKes: number) {
  if (!lossLimitKes || !usdKes) {
    return 0
  }

  return Math.ceil((lossLimitKes / usdKes) * 100) / 100
}

function formatStableAmount(value: number) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value)
}

function canEditSlip(bet: BetSlip, now: number) {
  if (bet.settledAt) {
    return now - bet.settledAt <= SETTLEMENT_EDIT_WINDOW_MS
  }

  return now - bet.createdAt <= EDIT_WINDOW_MS
}

function formatRemainingEditTime(bet: BetSlip, now: number) {
  const windowMs = bet.settledAt ? SETTLEMENT_EDIT_WINDOW_MS : EDIT_WINDOW_MS
  const start = bet.settledAt ?? bet.createdAt
  const remaining = Math.max(0, windowMs - (now - start))
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function canEditResult(bet: BetSlip, now: number) {
  if (bet.status === 'pending') {
    return true
  }

  return canEditSlip(bet, now)
}

function getVaultErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  const normalized = message.toLowerCase()

  if (
    normalized.includes('user rejected') ||
    normalized.includes('user denied') ||
    normalized.includes('request rejected') ||
    normalized.includes('rejected transaction')
  ) {
    if (normalized.includes('approve')) {
      return `Approval cancelled. Approve ${STABLE_TOKEN_SYMBOL} before depositing.`
    }

    return 'Transaction cancelled. No funds moved.'
  }

  if (message.includes('0x5c2262de') || message.includes('AmountMustBePositive')) {
    return 'There is nothing to withdraw from this balance yet.'
  }

  if (message.includes('0x2e6d26c0') || message.includes('SavingsStillLocked')) {
    return 'Protected savings are still locked. Wait for the unlock date.'
  }

  if (message.includes('0x2c0861a9') || message.includes('InsufficientBankroll')) {
    return 'That amount is higher than your available bankroll.'
  }

  if (message.includes('allowance')) {
    return 'Approval is not ready yet. Wait a moment, then try again.'
  }

  if (normalized.includes('insufficient funds')) {
    return 'Not enough funds for this transaction.'
  }

  return 'Transaction failed. Check your wallet and try again.'
}

function getWalletErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : ''

  if (message.includes('user rejected') || message.includes('user denied')) {
    return 'Wallet connection cancelled.'
  }

  if (message.includes('no provider') || message.includes('window.ethereum')) {
    return 'Open this app in MiniPay or another Celo wallet.'
  }

  return 'Wallet connection failed. Try again from MiniPay.'
}

function getWalletStatusTone(message: string) {
  const normalized = message.toLowerCase()

  if (
    normalized.includes('cancelled') ||
    normalized.includes('failed') ||
    normalized.includes('not enough') ||
    normalized.includes('nothing to withdraw') ||
    normalized.includes('higher than') ||
    normalized.includes('still locked')
  ) {
    return 'error'
  }

  if (
    normalized.includes('wait') ||
    normalized.includes('open this app') ||
    normalized.includes('not connected')
  ) {
    return 'warning'
  }

  return 'success'
}

function getVaultModeLabel(mode: VaultAction) {
  if (mode === 'deposit') {
    return 'Confirm deposit'
  }

  if (mode === 'withdrawBankroll') {
    return 'Confirm withdrawal'
  }

  if (mode === 'protect') {
    return 'Lock funds'
  }

  return 'Unlock to bankroll'
}

function Metric({ label, tone, value }: { label: string; tone?: 'good' | 'bad'; value: string }) {
  return (
    <article className={`metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function formatKes(value: number) {
  return new Intl.NumberFormat('en-KE', {
    currency: 'KES',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(value)
}

function formatLockCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)

  return `${days}d ${hours}h ${minutes}m`
}

function formatHistoryTime(value: number) {
  return new Intl.DateTimeFormat('en-KE', {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(value))
}

function shortHash(hash: string) {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

function normalizeLockSeconds(seconds?: number, legacyDays?: number) {
  if (seconds && seconds > 0) {
    return seconds
  }

  if (legacyDays && legacyDays > 0) {
    return legacyDays * 24 * 60 * 60
  }

  return TEST_LOCK_SECONDS
}

function formatLockDuration(seconds: number) {
  if (seconds < 60 * 60) {
    const minutes = Math.max(1, Math.round(seconds / 60))
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }

  if (seconds < 24 * 60 * 60) {
    const hours = Math.round(seconds / (60 * 60))
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }

  const days = Math.round(seconds / (24 * 60 * 60))
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

declare global {
  interface Window {
    ethereum?: {
      isMiniPay?: boolean
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
    }
  }
}

export default App
