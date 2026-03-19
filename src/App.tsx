import React, { useState, useEffect, useCallback, Component } from "react";
import { Search, Upload, FileSpreadsheet, Package, MapPin, User, DollarSign, Calendar, AlertCircle, CheckCircle2, Loader2, ChevronRight, ChevronLeft, Filter, Download, Lock, LogOut, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import * as XLSX from "xlsx";
import { auth, db, loginAnonymously } from "./firebase";
import { onAuthStateChanged, signOut, User as FirebaseUser } from "firebase/auth";
import { collection, query, where, onSnapshot, limit, doc, getDoc, getDocFromServer } from "firebase/firestore";

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || "não autenticado",
      email: auth.currentUser?.email || "null",
      emailVerified: auth.currentUser?.emailVerified || false,
      isAnonymous: auth.currentUser?.isAnonymous || false,
      tenantId: auth.currentUser?.tenantId || "null",
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName || "",
        email: provider.email || "",
        photoUrl: provider.photoURL || ""
      })) || []
    },
    operationType,
    path
  }
  
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  
  // Se for erro de permissão, retornar uma mensagem amigável em vez do JSON
  if (errInfo.error.toLowerCase().includes("permission") || errInfo.error.toLowerCase().includes("insufficient")) {
    const friendlyMessage = "Erro de Permissão: Você não tem autorização para realizar esta operação. Certifique-se de estar logado como Administrador e que seu perfil foi criado corretamente.";
    throw new Error(friendlyMessage);
  }
  
  throw new Error(JSON.stringify(errInfo));
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorInfo: string;
}

class ErrorBoundary extends (Component as any) {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, errorInfo: "" };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorInfo: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-red-50 flex items-center justify-center p-4">
          <div className="bg-white p-8 rounded-3xl shadow-xl max-w-lg w-full text-center space-y-4 border border-red-100">
            <AlertCircle className="w-16 h-16 text-red-500 mx-auto" />
            <h2 className="text-2xl font-bold text-gray-900">Ops! Algo deu errado</h2>
            <p className="text-gray-600">Ocorreu um erro inesperado no sistema. Por favor, tente recarregar a página.</p>
            <button 
              onClick={() => window.location.reload()}
              className="bg-red-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-red-700 transition-colors"
            >
              Recarregar Página
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface OrderData {
  ROTA?: string;
  OBS_SHEET?: string;
  N?: number;
  PEDIDO?: string | number;
  LOTE?: string | number;
  VENDEDOR?: string;
  PRAÇA?: string;
  CLIENTE?: string;
  ENDERECO?: string;
  BAIRRO?: string;
  CIDADE?: string;
  PESO?: number;
  VALOR?: number;
  CANAL?: string;
  DATA?: string | number;
  [key: string]: any;
}

interface Stats {
  totalRecords: number;
  lastUpdated: string | null;
}

interface AuthUser {
  role: "admin" | "vendedor";
  vendorCode?: string;
}

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

function App() {
  const [fbUser, setFbUser] = useState<FirebaseUser | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [activeTab, setActiveTab] = useState<"search" | "admin">("search");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchField, setSearchField] = useState("");
  const [results, setResults] = useState<OrderData[]>([]);
  const [loading, setLoading] = useState(false);
  const [isDatabaseEmpty, setIsDatabaseEmpty] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sheetsUrl, setSheetsUrl] = useState("");
  const [syncStatus, setSyncStatus] = useState<{ success?: boolean; message?: string } | null>(null);
  const [stats, setStats] = useState<Stats>({ totalRecords: 0, lastUpdated: null });
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setFbUser(u);
      setIsAuthReady(true);
      
      if (u) {
        // Restore user role from Firestore if not in state
        if (!user) {
          try {
            const userDoc = await getDoc(doc(db, "users", u.uid));
            if (userDoc.exists()) {
              const data = userDoc.data();
              setUser({ role: data.role, vendorCode: data.vendorCode });
            }
          } catch (e) {
            console.error("Error restoring user role", e);
          }
        }

        // Test connection
        const testConnection = async () => {
          try {
            await getDocFromServer(doc(db, 'test', 'connection'));
          } catch (error) {
            if(error instanceof Error && error.message.includes('the client is offline')) {
              console.error("Please check your Firebase configuration. The client is offline.");
              setMessage({ 
                type: "error", 
                text: "Erro de conexão: O banco de dados Firestore não foi encontrado ou a configuração está incorreta. Verifique se você criou o banco de dados no Console do Firebase." 
              });
            }
          }
        };
        testConnection();
      }
    });
    return () => unsubscribe();
  }, []);

  const filteredStats = React.useMemo(() => {
    const uniqueCities = new Set(results.map(r => r.CIDADE).filter(Boolean));
    return {
      count: results.length,
      cities: uniqueCities.size
    };
  }, [results]);

  const fetchStats = useCallback(async () => {
    if (!fbUser) return;
    const path = "stats/global";
    try {
      const statsDoc = await getDoc(doc(db, "stats", "global"));
      if (statsDoc.exists()) {
        setStats(statsDoc.data() as Stats);
      }
    } catch (e) {
      handleFirestoreError(e, OperationType.GET, path);
    }
  }, [fbUser]);

  const handleSearch = useCallback((queryStr: string, field: string) => {
    if (!fbUser || !auth.currentUser) return;
    setLoading(true);
    
    let q = query(collection(db, "orders"), limit(500));
    
    if (user?.role === "vendedor" && user.vendorCode) {
      // If the vendor code was manually entered, we use it, otherwise we might use UID
      // For now, let's stick to the vendor code logic
      q = query(collection(db, "orders"), where("VENDEDOR", "==", user.vendorCode), limit(500));
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!auth.currentUser) return;
      console.log(`Snapshot recebido: ${snapshot.size} documentos encontrados.`);
      
      if (snapshot.empty) {
        setIsDatabaseEmpty(true);
        setResults([]);
        setLoading(false);
        return;
      }

      setIsDatabaseEmpty(false);
      let data = snapshot.docs.map(doc => doc.data() as OrderData);
      
      if (queryStr) {
        const s = queryStr.toLowerCase();
        data = data.filter(item => {
          if (field && item[field]) {
            return String(item[field]).toLowerCase().includes(s);
          }
          return Object.values(item).some(val => String(val).toLowerCase().includes(s));
        });
      }
      
      setResults(data);
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, "orders");
      setLoading(false);
    });

    return unsubscribe;
  }, [fbUser, user]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");

    if (password === "@adminMarsil2026") {
      try {
        const cred = await loginAnonymously();
        // Create/Update admin profile in Firestore so rules can verify
        const { doc, setDoc } = await import("firebase/firestore");
        await setDoc(doc(db, "users", cred.user.uid), {
          role: "admin",
          updatedAt: new Date().toISOString()
        });
        setUser({ role: "admin" });
      } catch (error: any) {
        console.error("Login failed", error);
        if (error.code === "auth/admin-restricted-operation") {
          setLoginError("Erro: A Autenticação Anônima não está ativa no projeto correto (gen-lang-client-0554604238).");
        } else {
          setLoginError("Erro ao conectar ao servidor. Verifique se a Autenticação Anônima está ativa no Firebase.");
        }
      }
    } else if (password.toLowerCase().startsWith("marsil-")) {
      const parts = password.split("-");
      if (parts.length >= 2 && parts[1].trim()) {
        try {
          await loginAnonymously();
          setUser({ role: "vendedor", vendorCode: parts[1].trim() });
        } catch (error) {
          setLoginError("Erro ao conectar ao servidor.");
        }
      } else {
        setLoginError("Senha de vendedor inválida. Use marsil-CÓDIGO.");
      }
    } else {
      setLoginError("Senha incorreta.");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
    setPassword("");
    setResults([]);
    setActiveTab("search");
  };

  const handleExport = () => {
    if (results.length === 0) return;
    
    const exportData = results.map((item) => ({
      "Número do Pedido": item.PEDIDO || "-",
      "Nome do Cliente": item.CLIENTE ? (String(item.CLIENTE).length > 25 ? String(item.CLIENTE).substring(0, 25) : String(item.CLIENTE)) : "-",
      "Cidade": item.CIDADE || "-"
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Resumo");
    XLSX.writeFile(workbook, `Resumo_Pedidos_${new Date().getTime()}.xlsx`);
  };

  useEffect(() => {
    if (fbUser) {
      fetchStats();
      const unsubscribe = handleSearch(searchQuery, searchField);
      return () => unsubscribe && unsubscribe();
    }
  }, [fbUser, fetchStats, searchQuery, searchField, handleSearch]);

  const handleSyncSheets = async () => {
    if (!sheetsUrl) return;
    setUploading(true);
    setSyncStatus(null);
    try {
      let exportUrl = sheetsUrl;
      if (sheetsUrl.includes("docs.google.com/spreadsheets")) {
        if (sheetsUrl.includes("/pubhtml") || sheetsUrl.includes("/pub?")) {
          exportUrl = sheetsUrl.replace("/pubhtml", "/pub").split("?")[0] + "?output=csv";
          if (sheetsUrl.includes("gid=")) {
            const gidMatch = sheetsUrl.match(/gid=([0-9]+)/);
            if (gidMatch) exportUrl += `&gid=${gidMatch[1]}`;
          }
        } else {
          const match = sheetsUrl.match(/\/d\/(.+?)(\/|$)/);
          if (match && match[1]) {
            exportUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv`;
            const gidMatch = sheetsUrl.match(/gid=([0-9]+)/);
            if (gidMatch) exportUrl += `&gid=${gidMatch[1]}`;
          }
        }
      }

      const response = await fetch(exportUrl);
      if (!response.ok) throw new Error("Falha ao buscar planilha. Verifique se o link é público.");

      const text = await response.text();
      const workbook = XLSX.read(text, { type: "string" });
      const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" }) as any[];

      // Normalizar chaves para maiúsculas e valores importantes para string
      const jsonData = rawData.map(item => {
        const newItem: any = {};
        Object.keys(item).forEach(key => {
          const upperKey = key.toUpperCase().trim();
          let value = item[key];
          // Normalizar campos de busca para string
          if (["PEDIDO", "VENDEDOR", "LOTE", "CLIENTE", "CIDADE"].includes(upperKey)) {
            value = value !== undefined && value !== null ? String(value).trim() : "";
          }
          newItem[upperKey] = value;
        });
        return newItem;
      }).filter(item => item.PEDIDO && item.CLIENTE); // Filtrar linhas inválidas ou vazias

      await saveOrdersToFirestore(jsonData);
      setSyncStatus({ success: true, message: `Sincronizado com sucesso! (${jsonData.length} registros)` });
      fetchStats();
    } catch (error: any) {
      console.error("Sync failed", error);
      setSyncStatus({ success: false, message: error.message || "Erro ao sincronizar." });
    } finally {
      setUploading(false);
    }
  };

  const saveOrdersToFirestore = async (orders: any[]) => {
    const { writeBatch, doc, collection } = await import("firebase/firestore");
    const batchSize = 500;
    const path = "orders";
    try {
      for (let i = 0; i < orders.length; i += batchSize) {
        const batch = writeBatch(db);
        const chunk = orders.slice(i, i + batchSize);
        chunk.forEach((order, index) => {
          const orderId = order.PEDIDO ? String(order.PEDIDO) : `order_${i + index}_${Date.now()}`;
          const docRef = doc(collection(db, "orders"), orderId);
          batch.set(docRef, order);
        });
        await batch.commit();
      }
      
      const statsRef = doc(db, "stats", "global");
      const { setDoc } = await import("firebase/firestore");
      await setDoc(statsRef, {
        totalRecords: orders.length,
        lastUpdated: new Date().toISOString()
      });
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, path);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setMessage(null);

    try {
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const bstr = evt.target?.result;
          const workbook = XLSX.read(bstr, { type: "binary" });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const rawData = XLSX.utils.sheet_to_json(worksheet) as any[];

          // Normalizar chaves para maiúsculas e valores importantes para string
          const jsonData = rawData.map(item => {
            const newItem: any = {};
            Object.keys(item).forEach(key => {
              const upperKey = key.toUpperCase().trim();
              let value = item[key];
              if (["PEDIDO", "VENDEDOR", "LOTE", "CLIENTE", "CIDADE"].includes(upperKey)) {
                value = value !== undefined && value !== null ? String(value).trim() : "";
              }
              newItem[upperKey] = value;
            });
            return newItem;
          }).filter(item => item.PEDIDO && item.CLIENTE); // Filtrar linhas inválidas ou vazias

          await saveOrdersToFirestore(jsonData);
          setMessage({ type: "success", text: `Sucesso! ${jsonData.length} registros carregados.` });
          fetchStats();
        } catch (err) {
          console.error("File processing failed", err);
          setMessage({ type: "error", text: "Falha ao processar arquivo Excel." });
        } finally {
          setUploading(false);
        }
      };
      reader.readAsBinaryString(file);
    } catch (e) {
      setMessage({ type: "error", text: "Erro ao ler arquivo." });
      setUploading(false);
    } finally {
      e.target.value = "";
    }
  };

  const fields = [
    { value: "PEDIDO", label: "Pedido" },
    { value: "CLIENTE", label: "Cliente" },
    { value: "VENDEDOR", label: "Vendedor" },
    { value: "CIDADE", label: "Cidade" },
    { value: "ROTA", label: "Rota" },
    { value: "LOTE", label: "Lote" },
  ];

  if (!user) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-4 font-sans">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-white p-8 rounded-[2.5rem] border border-[#E2E8F0] shadow-2xl w-full max-w-md space-y-8"
        >
          <div className="text-center space-y-2">
            <div className="bg-blue-600 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-200">
              <Lock className="text-white w-8 h-8" />
            </div>
            <h1 className="text-3xl font-bold text-[#0F172A]">Acesso Restrito</h1>
            <p className="text-[#64748B]">Entre com sua senha para acessar o sistema Marsil.</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-bold text-[#1E293B] ml-1">Senha</label>
              <input
                type="password"
                placeholder="Sua senha de acesso"
                className="w-full px-6 py-4 bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all text-lg"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            </div>

            {loginError && (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-red-50 text-red-600 p-4 rounded-xl text-sm font-medium border border-red-100 flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4" />
                {loginError}
              </motion.div>
            )}

            <button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-bold text-lg shadow-lg shadow-blue-200 transition-all active:scale-[0.98]"
            >
              Entrar no Sistema
            </button>
          </form>

          <div className="pt-4 text-center">
            <p className="text-xs text-[#94A3B8]">
              Marsil - Logística e Distribuição © 2026
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#1E293B] font-sans">
      {/* Header */}
      <header className="bg-white border-b border-[#E2E8F0] sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg shadow-sm">
              <FileSpreadsheet className="text-white w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-[#0F172A]">
              Gestao <span className="text-blue-600">Rotas</span>
            </h1>
          </div>
          
          <div className="flex items-center gap-4">
            <nav className="flex bg-[#F1F5F9] p-1 rounded-xl">
              <button
                onClick={() => setActiveTab("search")}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  activeTab === "search" ? "bg-white shadow-sm text-blue-600" : "text-[#64748B] hover:text-[#1E293B]"
                }`}
              >
                Consulta
              </button>
              {user.role === "admin" && (
                <button
                  onClick={() => setActiveTab("admin")}
                  className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    activeTab === "admin" ? "bg-white shadow-sm text-blue-600" : "text-[#64748B] hover:text-[#1E293B]"
                  }`}
                >
                  Upload
                </button>
              )}
            </nav>
            <button
              onClick={handleLogout}
              className="p-2 text-[#64748B] hover:text-red-500 transition-colors"
              title="Sair"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Bar */}
        <div className="mb-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-2xl border border-[#E2E8F0] shadow-sm flex items-center gap-4">
            <div className="bg-blue-50 p-3 rounded-xl">
              <Package className="text-blue-600 w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-[#64748B] uppercase tracking-wider">Total de Registros</p>
              <p className="text-xl font-bold text-[#0F172A]">{stats.totalRecords.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-white p-4 rounded-2xl border border-[#E2E8F0] shadow-sm flex items-center gap-4">
            <div className="bg-emerald-50 p-3 rounded-xl">
              <Calendar className="text-emerald-600 w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-[#64748B] uppercase tracking-wider">Última Atualização</p>
              <p className="text-sm font-bold text-[#0F172A]">
                {stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString("pt-BR") : "Nenhum dado"}
              </p>
            </div>
          </div>
          <div className="bg-white p-4 rounded-2xl border border-[#E2E8F0] shadow-sm flex items-center gap-4">
            <div className="bg-orange-50 p-3 rounded-xl">
              <Filter className="text-orange-600 w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-[#64748B] uppercase tracking-wider">Pedidos Filtrados</p>
              <p className="text-xl font-bold text-[#0F172A]">{filteredStats.count.toLocaleString()}</p>
            </div>
          </div>
          <div className="bg-white p-4 rounded-2xl border border-[#E2E8F0] shadow-sm flex items-center gap-4">
            <div className="bg-purple-50 p-3 rounded-xl">
              <MapPin className="text-purple-600 w-5 h-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-[#64748B] uppercase tracking-wider">Cidades Filtradas</p>
              <p className="text-xl font-bold text-[#0F172A]">{filteredStats.cities.toLocaleString()}</p>
            </div>
          </div>
        </div>

        <AnimatePresence mode="wait">
          {activeTab === "search" ? (
            <motion.div
              key="search"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              {/* Search Section */}
              <div className="bg-white p-6 rounded-3xl border border-[#E2E8F0] shadow-sm space-y-4">
                <div className="flex flex-col md:flex-row gap-4">
                  <div className="flex-1 relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#94A3B8] w-5 h-5" />
                    <input
                      type="text"
                      placeholder="Pesquisar por pedido, cliente, cidade..."
                      className="w-full pl-12 pr-4 py-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                      }}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Filter className="text-[#64748B] w-5 h-5" />
                    <select
                      className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl px-4 py-3 text-sm font-medium outline-none focus:ring-2 focus:ring-blue-500"
                      value={searchField}
                      onChange={(e) => {
                        setSearchField(e.target.value);
                      }}
                    >
                      <option value="">Todos os campos</option>
                      {fields.map(f => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={handleExport}
                      disabled={results.length === 0}
                      className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-2xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    >
                      <Download className="w-5 h-5" />
                      Exportar
                    </button>
                  </div>
                </div>
              </div>

              {/* Results Table */}
              <div className="bg-white rounded-3xl border border-[#E2E8F0] shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                        <th className="px-6 py-4 text-xs font-semibold text-[#64748B] uppercase tracking-wider">Data Pedido</th>
                        <th className="px-6 py-4 text-xs font-semibold text-[#64748B] uppercase tracking-wider">Data Arquivo</th>
                        <th className="px-6 py-4 text-xs font-semibold text-[#64748B] uppercase tracking-wider">Pedido / Lote</th>
                        <th className="px-6 py-4 text-xs font-semibold text-[#64748B] uppercase tracking-wider">Cliente</th>
                        <th className="px-6 py-4 text-xs font-semibold text-[#64748B] uppercase tracking-wider">Localização</th>
                        <th className="px-6 py-4 text-xs font-semibold text-[#64748B] uppercase tracking-wider">Vendedor</th>
                        <th className="px-6 py-4 text-xs font-semibold text-[#64748B] uppercase tracking-wider">Status/Rota</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E2E8F0]">
                      {loading ? (
                        <tr>
                          <td colSpan={7} className="px-6 py-12 text-center">
                            <Loader2 className="w-8 h-8 text-blue-600 animate-spin mx-auto mb-2" />
                            <p className="text-[#64748B] font-medium">Buscando dados no servidor...</p>
                          </td>
                        </tr>
                      ) : results.length > 0 ? (
                        results.map((item, idx) => (
                          <motion.tr 
                            key={idx}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ delay: Math.min(idx * 0.01, 0.5) }}
                            className="hover:bg-[#F8FAFC] transition-colors group cursor-pointer"
                          >
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2 text-sm font-medium text-[#475569]">
                                <Calendar className="w-4 h-4 text-blue-500" />
                                <span>{item.DATA ? (typeof item.DATA === 'number' ? XLSX.SSF.format('dd/mm/yyyy', item.DATA) : item.DATA) : "-"}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2 text-xs text-[#64748B]">
                                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-500" />
                                <span>{stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleDateString("pt-BR") : "-"}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex flex-col">
                                <span className="font-bold text-[#0F172A]">{item.PEDIDO || "-"}</span>
                                <span className="text-[10px] text-[#64748B]">Lote: {item.LOTE || "-"}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <div className="bg-slate-100 p-2 rounded-lg group-hover:bg-white transition-colors">
                                  <User className="w-4 h-4 text-slate-500" />
                                </div>
                                <div className="flex flex-col max-w-[200px]">
                                  <span className="font-medium text-[#1E293B] truncate">
                                    {item.CLIENTE ? (String(item.CLIENTE).length > 25 ? String(item.CLIENTE).substring(0, 25) + "..." : item.CLIENTE) : "N/A"}
                                  </span>
                                  <span className="text-xs text-[#64748B] truncate">{item.CANAL || "-"}</span>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-2 text-[#64748B]">
                                <MapPin className="w-4 h-4 shrink-0" />
                                <div className="flex flex-col text-xs">
                                  <span className="font-medium text-[#1E293B]">{item.CIDADE || "-"}</span>
                                  <span>{item.BAIRRO || "-"}</span>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm text-[#475569]">{item.VENDEDOR || "-"}</span>
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex flex-col gap-1">
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">
                                  Rota: {item.ROTA || "-"}
                                </span>
                                {item.OBS_SHEET && (
                                  <span className="text-[10px] text-[#94A3B8] italic truncate max-w-[120px]">
                                    {item.OBS_SHEET}
                                  </span>
                                )}
                              </div>
                            </td>
                          </motion.tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={7} className="px-6 py-12 text-center">
                            <div className="bg-slate-50 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                              <AlertCircle className="text-slate-400 w-8 h-8" />
                            </div>
                            <p className="text-[#64748B] font-medium">
                              {isDatabaseEmpty ? "O banco de dados está vazio. Vá em 'Upload' para carregar dados." : "Nenhum registro encontrado para esta busca."}
                            </p>
                            <p className="text-xs text-[#94A3B8]">
                              {isDatabaseEmpty ? "Use um arquivo Excel ou link do Google Sheets." : "Tente remover os filtros ou pesquisar por outro termo."}
                            </p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {results.length > 0 && (
                  <div className="bg-[#F8FAFC] px-6 py-4 border-t border-[#E2E8F0] flex items-center justify-between">
                    <p className="text-xs text-[#64748B]">
                      Exibindo <span className="font-bold text-[#1E293B]">{results.length}</span> resultados
                    </p>
                    <div className="flex gap-2">
                      <button className="p-2 rounded-lg border border-[#E2E8F0] bg-white text-[#64748B] hover:text-[#1E293B] disabled:opacity-50 transition-all">
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button className="p-2 rounded-lg border border-[#E2E8F0] bg-white text-[#64748B] hover:text-[#1E293B] disabled:opacity-50 transition-all">
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="admin"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-2xl mx-auto"
            >
              <div className="bg-white p-8 rounded-[2rem] border border-[#E2E8F0] shadow-xl space-y-8">
                <div className="text-center space-y-2">
                  <div className="bg-emerald-50 w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <FileSpreadsheet className="text-emerald-600 w-8 h-8" />
                  </div>
                  <h2 className="text-2xl font-bold text-[#0F172A]">Configuração de Dados</h2>
                  <p className="text-[#64748B]">Sincronize com Google Sheets ou suba um arquivo Excel.</p>
                </div>

                <div className="space-y-6">
                  {/* Google Sheets Sync */}
                  <div className="p-6 bg-[#F8FAFC] rounded-2xl border-2 border-dashed border-[#E2E8F0] space-y-4">
                    <div className="flex items-center gap-2 mb-2">
                      <RefreshCw className={`w-4 h-4 text-blue-600 ${uploading ? 'animate-spin' : ''}`} />
                      <h3 className="text-sm font-bold text-[#1E293B]">Sincronizar Google Sheets</h3>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Cole o link da planilha aqui..."
                        className="flex-1 px-4 py-2.5 rounded-xl border border-[#E2E8F0] bg-white focus:ring-2 focus:ring-blue-500 outline-none text-sm transition-all"
                        value={sheetsUrl}
                        onChange={(e) => setSheetsUrl(e.target.value)}
                      />
                      <button
                        onClick={handleSyncSheets}
                        disabled={uploading || !sheetsUrl}
                        className="px-6 py-2.5 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg shadow-blue-200 transition-all active:scale-95"
                      >
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sincronizar"}
                      </button>
                    </div>

                    {syncStatus && (
                      <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`p-3 rounded-xl text-xs font-medium flex items-center gap-2 ${
                          syncStatus.success ? "bg-emerald-50 text-emerald-600 border border-emerald-100" : "bg-red-50 text-red-600 border border-red-100"
                        }`}
                      >
                        {syncStatus.success ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                        {syncStatus.message}
                      </motion.div>
                    )}

                    <p className="text-[10px] text-[#94A3B8] leading-relaxed">
                      Dica: Use o link de <strong>Compartilhamento</strong> (Qualquer pessoa com o link) ou o link de <strong>Publicar na Web</strong> (CSV). 
                      O sistema converterá automaticamente para o formato correto.
                    </p>
                  </div>

                  <div className="relative flex items-center py-2">
                    <div className="flex-grow border-t border-[#E2E8F0]"></div>
                    <span className="flex-shrink mx-4 text-[10px] font-bold text-[#94A3B8] uppercase tracking-widest">Ou upload manual</span>
                    <div className="flex-grow border-t border-[#E2E8F0]"></div>
                  </div>

                  {/* Manual File Upload */}
                  <div className="relative">
                    <input
                      type="file"
                      accept=".xlsx, .xls"
                      onChange={handleFileUpload}
                      className="hidden"
                      id="excel-upload"
                      disabled={uploading}
                    />
                    <label
                      htmlFor="excel-upload"
                      className={`flex items-center justify-center w-full p-6 border-2 border-dashed rounded-2xl cursor-pointer transition-all ${
                        uploading 
                          ? "bg-slate-50 border-slate-200 cursor-not-allowed" 
                          : "bg-[#F8FAFC] border-[#E2E8F0] hover:border-blue-400 hover:bg-blue-50/30"
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <div className="bg-white p-3 rounded-xl shadow-sm border border-[#E2E8F0]">
                          <Upload className="w-6 h-6 text-blue-600" />
                        </div>
                        <div className="text-left">
                          <p className="text-sm font-bold text-[#1E293B]">Upload de arquivo</p>
                          <p className="text-xs text-[#64748B]">Clique para selecionar .xlsx ou .xls</p>
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                <AnimatePresence>
                  {(message || syncStatus) && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className={`p-4 rounded-2xl flex items-center gap-3 ${
                        (message?.type === "success" || syncStatus?.success) 
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-100" 
                          : "bg-red-50 text-red-700 border border-red-100"
                      }`}
                    >
                      {(message?.type === "success" || syncStatus?.success) ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                      <span className="text-sm font-medium">{message?.text || syncStatus?.message}</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="bg-[#F8FAFC] p-6 rounded-2xl border border-[#E2E8F0]">
                  <h3 className="text-sm font-bold text-[#0F172A] mb-3 flex items-center gap-2">
                    <Filter className="w-4 h-4 text-blue-600" />
                    Estrutura Esperada (Colunas)
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {["ROTA", "PEDIDO", "CLIENTE", "CIDADE", "VENDEDOR", "PESO", "DATA"].map(col => (
                      <span key={col} className="px-2 py-1 bg-white border border-[#E2E8F0] rounded-lg text-[10px] font-mono text-[#64748B]">
                        {col}
                      </span>
                    ))}
                    <span className="px-2 py-1 bg-white border border-[#E2E8F0] rounded-lg text-[10px] font-mono text-[#64748B]">...</span>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 border-t border-[#E2E8F0] mt-12">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-sm text-[#64748B]">
            © 2026 Consulta de Pedidos. Todos os direitos reservados.
          </p>
          <div className="flex items-center gap-6">
            <a href="#" className="text-sm text-[#64748B] hover:text-blue-600 transition-colors">Suporte</a>
            <a href="#" className="text-sm text-[#64748B] hover:text-blue-600 transition-colors">Privacidade</a>
            <div className="h-4 w-px bg-[#E2E8F0]"></div>
            <p className="text-xs font-medium text-[#94A3B8]">Versão 1.0.0</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
