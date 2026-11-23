        const { createApp, ref, reactive, computed, onMounted, nextTick, watch } = Vue;

        // 当前运行版本：与镜像标签、Dockerfile OCI 版本保持一致，设置页展示用
        const APP_VERSION = '1.2.1';

        const app = createApp({
            setup() {
                // =============== 数据状态 ===============
                const activeTab = ref('home');
                const chartPeriod = ref('thisyear'); 
                const selectedChartCategory = ref(''); 
                
                const appSettings = reactive({
                    costUnit: '元/百公里',
                    fuelUnit: 'L/百公里',
                    maintKm: 10000,
                    maintMonths: 12,
                    csMode: 'auto',
                    csDuty: 0.18,
                    role: 'admin',
                    categoryOrderCustom: false,
                    backupIntervalDays: 7
                });

                const opLogs = ref([]);
                // 操作日志筛选与分页（S9）：仅影响展示，不改变日志存储与保留上限
                const logFilter = reactive({ action: '', categoryName: '' });
                const logPage = ref(1);
                const logPageSize = 10;
                const sortDialogVisible = ref(false);
                const sortDraft = ref([]);
                const currentRole = computed(() => appSettings.role || 'admin');
                const canEdit = computed(() => currentRole.value !== 'viewer');
                const canManage = computed(() => currentRole.value === 'admin');
                const subCategories = computed(() => categories.value.filter(c => c.hasSub && c.active !== false));

                const vehicles = ref([]);
                const currentVehicleId = ref('');
                
                const defaultVehicles = [
                    { id: 'v_default', name: '默认爱车' }
                ];

                const subItemsFromNames = (names, prefix) => names.map((name, i) => ({
                    id: `${prefix}_${i}`, name, active: true, aliases: []
                }));

                const defaultCategories = [
                    { id: '1', name: '加油', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: true },
                    { id: '2', name: '充电', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: true },
                    { id: '3', name: '保险', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: false },
                    { id: '4', name: '保养', type: 'expense', hasSub: true, subItems: subItemsFromNames(['机油机滤', '空调滤芯', '空气滤芯'], 'sub_m'), newSubInput: '', requireMileage: true },
                    { id: '5', name: '维修', type: 'expense', hasSub: true, subItems: subItemsFromNames(['更换雨刮', '轮胎更换', '钣金喷漆', '太阳膜'], 'sub_r'), newSubInput: '', requireMileage: true },
                    { id: '6', name: '违章', type: 'expense', hasSub: true, subItems: subItemsFromNames(['超速', '闯红灯', '违停', '违规变道'], 'sub_v'), newSubInput: '', requireMileage: false },
                    { id: '7', name: '停车', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: false },
                    { id: '8', name: '过路费', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: false },
                    { id: '10', name: '洗车', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: false },
                    { id: '11', name: '购车/车贷', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: false },
                    { id: '12', name: '年检', type: 'expense', hasSub: false, subItems: [], newSubInput: '', requireMileage: false },
                    { id: '9', name: '顺风车', type: 'income', hasSub: false, subItems: [], newSubInput: '', requireMileage: false }
                ];

                const categories = ref([]);
                const records = ref([]);
                const renameSnapshot = ref(null);

                // 本地日期字符串（YYYY-MM-DD），避免 toISOString 的时区偏移
                const todayStr = () => {
                    const d = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
                };
                
                const form = reactive({
                    id: '', date: todayStr(), recordType: 'expense', categoryId: '', categoryName: '', subCategory: '', subCategoryList: [],
                    amount: 0, hev: 0, ev: 0, liters: 0, kwh: null, kwhSource: 'pile', totalMileage: 0, remark: '',
                    // 充电 SOC：均为选填，终止 SOC 默认 100
                    startSoc: null, endSoc: 100
                });

                // 记录编辑（弹窗）状态
                const editVisible = ref(false);
                const editSaving = ref(false);
                const editingId = ref('');
                const editForm = reactive({
                    date: '', recordType: 'expense', categoryId: '', categoryName: '', subCategoryList: [],
                    amount: 0, hev: 0, ev: 0, liters: 0, kwh: null, kwhSource: 'pile', totalMileage: 0, remark: '',
                    startSoc: null, endSoc: null
                });
                const editCategories = computed(() =>
                    categories.value.filter(c =>
                        c.type === (editForm.recordType === 'income' ? 'income' : 'expense') &&
                        (c.active !== false || c.id === editForm.categoryId)
                    )
                );
                const editTargetCategory = computed(() => categories.value.find(c => c.id === editForm.categoryId));
                const editActiveSubItems = computed(() =>
                    editTargetCategory.value ? editTargetCategory.value.subItems.filter(s => s.active !== false) : []
                );

                // 核心获取真实里程的函数（显式数值化，避免字符串里程参与运算）
                const getMileage = (r) => Number(r.totalMileage) || ((Number(r.hev) || 0) + (Number(r.ev) || 0)) || 0;

                // 表格 SOC 展示：空值（非充电记录或未填写）统一显示为 "-"
                const formatSoc = (val) => (val === null || val === undefined || val === '') ? '-' : val;

                const tableFilter = reactive({ dateRange: [], recordType: '', categoryId: '' });
                const recordSortMode = ref('time');

                const activeRecords = computed(() => {
                    return records.value.filter(r => r.vehicleId === currentVehicleId.value);
                });

                const filteredTableRecords = computed(() => {
                    let res = activeRecords.value;
                    if (tableFilter.dateRange && tableFilter.dateRange.length === 2) {
                        res = res.filter(r => r.date >= tableFilter.dateRange[0] && r.date <= tableFilter.dateRange[1]);
                    }
                    if (tableFilter.recordType) res = res.filter(r => r.recordType === tableFilter.recordType);
                    if (tableFilter.categoryId) res = res.filter(r => r.categoryId === tableFilter.categoryId);
                    return res;
                });

                const tableStats = computed(() => {
                    let exp = 0, inc = 0;
                    filteredTableRecords.value.forEach(r => {
                        const amount = Number(r.amount) || 0;
                        if(r.recordType === 'expense') exp += amount;
                        else inc += amount;
                    });
                    return { exp, inc };
                });

                const showSubCatPie = computed(() => {
                    const cat = categories.value.find(c => c.name === selectedChartCategory.value);
                    return cat ? cat.hasSub : false;
                });

                // ==================== 智能管家预测模块 ====================
                const maintenanceInfo = computed(() => {
                    const mileageRecords = activeRecords.value.filter(r => getMileage(r) > 0);
                    const currentMileage = mileageRecords.length ? Math.max(...mileageRecords.map(r=>getMileage(r))) : 0;
                    
                    const maintRecords = activeRecords.value.filter(r => r.categoryName === '保养' && getMileage(r) > 0).sort((a,b) => new Date(b.date) - new Date(a.date));
                    
                    if (!maintRecords.length) return { hasRecord: false, currentMileage };
                    
                    const lastMaint = maintRecords[0];
                    const targetMileage = getMileage(lastMaint) + appSettings.maintKm;
                    const remainingKm = targetMileage - currentMileage;
                    
                    const lastDate = new Date(lastMaint.date);
                    const targetDate = new Date(lastDate.setMonth(lastDate.getMonth() + appSettings.maintMonths));
                    const today = new Date();
                    const remainingDays = Math.ceil((targetDate - today) / (1000 * 60 * 60 * 24));
                    
                    return { 
                        hasRecord: true, lastDate: lastMaint.date, lastMileage: getMileage(lastMaint), 
                        currentMileage, targetMileage, remainingKm, remainingDays, 
                        targetDateStr: targetDate.toISOString().slice(0,10) 
                    };
                });

                const insuranceInfo = computed(() => {
                    const records = activeRecords.value.filter(r => r.categoryName === '保险').sort((a,b) => new Date(b.date) - new Date(a.date));
                    if(!records.length) return null;
                    const lastRecord = records[0];
                    const lastDate = new Date(lastRecord.date);
                    const targetDate = new Date(lastDate.setFullYear(lastDate.getFullYear() + 1));
                    const remainingDays = Math.ceil((targetDate - new Date()) / (1000 * 60 * 60 * 24));
                    return { lastDate: lastRecord.date, targetDateStr: targetDate.toISOString().slice(0,10), remainingDays };
                });

                const inspectionInfo = computed(() => {
                    const records = activeRecords.value.filter(r => r.categoryName === '年检').sort((a,b) => new Date(b.date) - new Date(a.date));
                    if(!records.length) return null;
                    const lastRecord = records[0];
                    const lastDate = new Date(lastRecord.date);
                    const targetDate = new Date(lastDate.setFullYear(lastDate.getFullYear() + 1));
                    const remainingDays = Math.ceil((targetDate - new Date()) / (1000 * 60 * 60 * 24));
                    return { lastDate: lastRecord.date, targetDateStr: targetDate.toISOString().slice(0,10), remainingDays };
                });
                // ==========================================================

                const currentVehicleName = computed(() => {
                    const v = vehicles.value.find(c => c.id === currentVehicleId.value);
                    return v ? v.name : '';
                });

                // 车辆记录数（S11）：用于设置页车辆管理表格展示
                const vehicleRecordCount = (vehicleId) => records.value.filter(r => r.vehicleId === vehicleId).length;

                // 停用类别（active=false）保留历史记录，但不再出现在新增与筛选下拉中
                const activeCategories = computed(() => categories.value.filter(c => c.active !== false));

                const filteredCategories = computed(() => {
                    return activeCategories.value.filter(c => c.type === form.recordType);
                });

                const EXPENSE_CATEGORY_ORDER = ['充电', '加油', '过路费', '停车', '洗车', '违章', '保养', '维修', '保险', '年检', '购车/车贷'];
                const sortCategories = (force = false) => {
                    if (appSettings.categoryOrderCustom && !force) return;
                    categories.value.sort((a, b) => {
                        const typeRankA = a.type === 'expense' ? 0 : 1;
                        const typeRankB = b.type === 'expense' ? 0 : 1;
                        if (typeRankA !== typeRankB) return typeRankA - typeRankB;
                        if (a.type === 'expense') {
                            const ia = EXPENSE_CATEGORY_ORDER.indexOf(a.name);
                            const ib = EXPENSE_CATEGORY_ORDER.indexOf(b.name);
                            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
                        }
                        return 0;
                    });
                };

                const requiresMileage = (categoryName) => {
                    const cat = categories.value.find(c => c.name === categoryName);
                    return cat ? cat.requireMileage : ['加油', '充电', '保养', '维修'].includes(categoryName);
                };

                // 新增里程记录时，默认带出当前车辆最近一组里程数据
                const latestMileageSnapshot = computed(() => {
                    const list = activeRecords.value.filter(r =>
                        (Number(r.hev) || 0) + (Number(r.ev) || 0) + (Number(r.totalMileage) || 0) > 0
                    );
                    if (!list.length) return null;
                    const latest = list.slice().sort((a, b) => {
                        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
                        return String(b.id).localeCompare(String(a.id));
                    })[0];
                    return {
                        hev: Number(latest.hev) || 0,
                        ev: Number(latest.ev) || 0,
                        totalMileage: Number(latest.totalMileage) || ((Number(latest.hev) || 0) + (Number(latest.ev) || 0))
                    };
                });

                const prefillLatestMileage = () => {
                    const snap = latestMileageSnapshot.value;
                    if (!snap) return;
                    form.hev = snap.hev;
                    form.ev = snap.ev;
                    nextTick(() => { form.totalMileage = snap.totalMileage; });
                };

                watch(
                    () => form.hev + form.ev,
                    (newSum) => {
                        if (newSum > 0 && form.categoryName && requiresMileage(form.categoryName)) {
                            form.totalMileage = newSum;
                        }
                    }
                );

                // 编辑弹窗内 HEV + EV 联动总里程
                watch(
                    () => (Number(editForm.hev) || 0) + (Number(editForm.ev) || 0),
                    (newSum) => {
                        if (newSum > 0 && editForm.categoryName && requiresMileage(editForm.categoryName)) {
                            editForm.totalMileage = newSum;
                        }
                    }
                );

                const currentPage = ref(1);
                const pageSize = ref(10);

                const currentCategory = computed(() => categories.value.find(c => c.id === form.categoryId));

                // 是否包含有效里程：总里程优先，缺失时回退 HEV + EV
                const hasMileageInfo = (r) => {
                    if (!r) return false;
                    if ((Number(r.totalMileage) || 0) > 0) return true;
                    return ((Number(r.hev) || 0) + (Number(r.ev) || 0)) > 0;
                };

                // 表格排序：日期倒序分组；默认保持添加时间倒序（新增置顶/手动顺序），
                // 切换“里程倒序”后组内含里程记录按里程数值倒序排列
                const sortedTableRecords = computed(() => {
                    const buckets = new Map();
                    filteredTableRecords.value.forEach(r => {
                        const key = r.date || '';
                        if (!buckets.has(key)) buckets.set(key, []);
                        buckets.get(key).push(r);
                    });
                    const dates = Array.from(buckets.keys()).sort((a, b) => (a === b ? 0 : (a < b ? 1 : -1)));
                    const result = [];
                    dates.forEach(date => {
                        const list = buckets.get(date);
                        if (recordSortMode.value === 'mileage') {
                            const mileageList = list.filter(hasMileageInfo).sort((a, b) => getMileage(b) - getMileage(a));
                            const manualList = list.filter(r => !hasMileageInfo(r));
                            result.push(...mileageList, ...manualList);
                        } else {
                            result.push(...list);
                        }
                    });
                    return result;
                });

                const paginatedRecords = computed(() => {
                    const start = (currentPage.value - 1) * pageSize.value;
                    return sortedTableRecords.value.slice(start, start + pageSize.value);
                });

                // 当前页按日期聚合，供表格分组表头展示
                const groupedRecords = computed(() => {
                    const groups = [];
                    let current = null;
                    paginatedRecords.value.forEach(r => {
                        const date = r.date || '未填写日期';
                        if (!current || current.date !== date) {
                            current = { date, records: [], expense: 0, income: 0 };
                            groups.push(current);
                        }
                        current.records.push(r);
                        const amount = Number(r.amount) || 0;
                        if (r.recordType === 'income') current.income += amount;
                        else current.expense += amount;
                    });
                    return groups;
                });

                // =============== 初始化与持久化 ===============
                const makeSubId = () => 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

                const normalizeSubItems = () => {
                    categories.value.forEach(cat => {
                        if (!Array.isArray(cat.subItems)) cat.subItems = [];
                        cat.subItems = cat.subItems.map((item, idx) => {
                            if (typeof item === 'string') {
                                return { id: makeSubId() + idx, name: item, active: true, aliases: [] };
                            }
                            return {
                                id: item.id || (makeSubId() + idx),
                                name: item.name || String(item),
                                active: item.active !== false,
                                aliases: Array.isArray(item.aliases) ? item.aliases : []
                            };
                        });
                    });
                    records.value.forEach(r => {
                        if (Array.isArray(r.subCategoryIds)) return;
                        const cat = categories.value.find(c => c.id === r.categoryId);
                        const tokens = String(r.subCategory || '').split('、').filter(Boolean);
                        r.subCategoryIds = cat
                            ? tokens.map(t => {
                                const hit = cat.subItems.find(s => s.name === t);
                                return hit ? hit.id : null;
                            }).filter(Boolean)
                            : [];
                    });
                };

                const OPERATION_LOG_KEY = 'hev_op_logs';
                // 日志保留上限：与设置页提示文案共用同一常量，避免描述与实际存储逻辑脱节
                const LOG_LIMIT = 1000;

                const loadOpLogs = () => {
                    let list = [];
                    try {
                        const parsed = JSON.parse(localStorage.getItem(OPERATION_LOG_KEY));
                        if (Array.isArray(parsed)) list = parsed;
                    } catch (e) { list = []; }
                    opLogs.value = list.slice(0, LOG_LIMIT);
                    logPage.value = 1;
                    // 历史或导入数据可能超过上限：加载时裁剪并回写，保证存储内容同样不超过上限
                    if (list.length > LOG_LIMIT) {
                        try { localStorage.setItem(OPERATION_LOG_KEY, JSON.stringify(opLogs.value)); } catch (e) {}
                    }
                };

                const appendOperationLog = (entry) => {
                    const log = {
                        id: 'log_' + Date.now(),
                        ts: Date.now(),
                        operator: 'local',
                        ...entry
                    };
                    opLogs.value = [log, ...opLogs.value].slice(0, LOG_LIMIT);
                    localStorage.setItem(OPERATION_LOG_KEY, JSON.stringify(opLogs.value));
                };

                const logActionLabel = (action) => ({
                    'rename-subtag': '重命名',
                    'merge-subtag': '合并',
                    'deactivate-subtag': '停用',
                    'reactivate-subtag': '启用',
                    'delete-subtag': '删除',
                    'undo-rename': '撤销',
                    'delete-category': '删除类别',
                    'migrate-category': '迁移类别',
                    'deactivate-category': '停用类别',
                    'reactivate-category': '启用类别'
                }[action] || action);

                const formatLogTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '-';

                // =============== 操作日志筛选、分页与导出（S9） ===============
                const logActionOptions = computed(() => {
                    const actions = Array.from(new Set(opLogs.value.map(l => l.action).filter(Boolean)));
                    return actions.map(a => ({ value: a, label: logActionLabel(a) }));
                });
                const logCategoryOptions = computed(() =>
                    Array.from(new Set(opLogs.value.map(l => l.categoryName).filter(Boolean)))
                );
                const filteredOpLogs = computed(() => opLogs.value.filter(l =>
                    (!logFilter.action || l.action === logFilter.action) &&
                    (!logFilter.categoryName || l.categoryName === logFilter.categoryName)
                ));
                const paginatedOpLogs = computed(() => {
                    const start = (logPage.value - 1) * logPageSize;
                    return filteredOpLogs.value.slice(start, start + logPageSize);
                });
                const resetLogPage = () => { logPage.value = 1; };
                const clearLogFilter = () => {
                    logFilter.action = '';
                    logFilter.categoryName = '';
                    logPage.value = 1;
                };

                const exportOpLogs = () => {
                    if (!filteredOpLogs.value.length) {
                        ElementPlus.ElMessage.warning('当前筛选条件下没有可导出的日志');
                        return;
                    }
                    const esc = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
                    let csv = '\uFEFF时间,操作类型,类别,变更前,变更后,影响条数,结果\n';
                    filteredOpLogs.value.forEach(l => {
                        csv += [
                            esc(formatLogTime(l.ts)),
                            esc(logActionLabel(l.action)),
                            esc(l.categoryName || ''),
                            esc(l.oldName || ''),
                            esc(l.newName || ''),
                            esc(l.affectedRecords === undefined || l.affectedRecords === null ? '' : l.affectedRecords),
                            esc(l.result === 'success' ? '成功' : (l.result || ''))
                        ].join(',') + '\n';
                    });
                    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `操作日志_${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    ElementPlus.ElMessage.success(`已导出 ${filteredOpLogs.value.length} 条操作日志`);
                };

                // 文案迁移：历史“高速费”统一为“过路费”
                const migrateLegacyLabels = () => {
                    categories.value.forEach(c => {
                        if (c.name === '高速费') c.name = '过路费';
                    });
                    records.value.forEach(r => {
                        if (r.categoryName === '高速费') r.categoryName = '过路费';
                    });
                };

                // 数值字段归一化：历史导入或旧版本数据可能把金额等字段存为字符串，
                // 直接参与累加会发生字符串拼接，导致金额异常偏大；加载与导入时统一转为有限数值。
                const toFiniteNumber = (val, fallback = 0) => {
                    const num = Number(val);
                    return Number.isFinite(num) ? num : fallback;
                };

                // 载入 / 导入时清洗记录：数值归一化 + 按 id 去重，避免脏数据随整表写回扩散
                const normalizeRecords = (list) => {
                    const seenIds = new Set();
                    return (Array.isArray(list) ? list : []).reduce((acc, raw) => {
                        if (!raw || typeof raw !== 'object') return acc;
                        if (raw.id !== null && raw.id !== undefined && String(raw.id) !== '') {
                            const key = String(raw.id);
                            if (seenIds.has(key)) return acc;
                            seenIds.add(key);
                        }
                        const r = { ...raw };
                        r.amount = toFiniteNumber(r.amount);
                        r.liters = toFiniteNumber(r.liters);
                        r.hev = toFiniteNumber(r.hev);
                        r.ev = toFiniteNumber(r.ev);
                        r.totalMileage = toFiniteNumber(r.totalMileage);
                        const emptyKwh = r.kwh === null || r.kwh === undefined || r.kwh === '';
                        r.kwh = emptyKwh ? null : toFiniteNumber(r.kwh, null);
                        r.startSoc = toSocInt(r.startSoc);
                        r.endSoc = toSocInt(r.endSoc);
                        acc.push(r);
                        return acc;
                    }, []);
                };

                const loadData = () => {
                    const savedVehicles = localStorage.getItem('hev_vehicles');
                    if (savedVehicles) vehicles.value = JSON.parse(savedVehicles);
                    else vehicles.value = defaultVehicles;
                    
                    if (vehicles.value.length > 0) currentVehicleId.value = vehicles.value[0].id;

                    const savedCats = localStorage.getItem('hev_categories');
                    if (savedCats) {
                        let parsedCats = JSON.parse(savedCats);
                        parsedCats.forEach(c => {
                            if (c.type === undefined) c.type = 'expense';
                            if (c.name === '高速费') c.name = '过路费';
                            if (c.requireMileage === undefined) c.requireMileage = ['加油', '充电', '保养', '维修'].includes(c.name);
                        });
                        const missingCats = [
                            { name: '停车', type: 'expense', hasSub: false, subItems: [], requireMileage: false },
                            { name: '过路费', type: 'expense', hasSub: false, subItems: [], requireMileage: false },
                            { name: '洗车', type: 'expense', hasSub: false, subItems: [], requireMileage: false },
                            { name: '购车/车贷', type: 'expense', hasSub: false, subItems: [], requireMileage: false },
                            { name: '年检', type: 'expense', hasSub: false, subItems: [], requireMileage: false },
                            { name: '顺风车', type: 'income', hasSub: false, subItems: [], requireMileage: false }
                        ];
                        missingCats.forEach(m => {
                            if (!parsedCats.find(c => c.name === m.name)) {
                                parsedCats.push({ id: 'cat_' + Date.now() + Math.random(), ...m, newSubInput: '' });
                            }
                        });
                        categories.value = parsedCats;
                    } else {
                        categories.value = defaultCategories;
                    }

                    if (categories.value.length > 0) {
                        selectedChartCategory.value = categories.value.some(c => c.name === '充电')
                            ? '充电'
                            : categories.value[0].name;
                    }
                    
                    const savedRecords = localStorage.getItem('hev_records');
                    if (savedRecords) {
                        let parsedRecords = normalizeRecords(JSON.parse(savedRecords));
                        parsedRecords.forEach(r => {
                            if (!r.recordType) r.recordType = 'expense'; 
                            if (!r.vehicleId) r.vehicleId = vehicles.value[0].id; 
                        });
                        records.value = parsedRecords;
                        // 历史数据一次性重排任务已取消：列表顺序以当前数组顺序为准，不再自动置换写回
                    }

                    const savedSettings = localStorage.getItem('hev_app_settings');
                    if (savedSettings) {
                        const parsedSet = JSON.parse(savedSettings);
                        if (parsedSet.maintKm === undefined) parsedSet.maintKm = 10000;
                        if (parsedSet.maintMonths === undefined) parsedSet.maintMonths = 12;
                        // CS 参数一次性迁移：旧版无 csMode 时进入自动模式，旧默认 0.50 改为 0.18
                        const legacyCsSettings = parsedSet.csMode === undefined;
                        if (legacyCsSettings) {
                            parsedSet.csMode = 'auto';
                            if (parsedSet.csDuty === undefined || Number(parsedSet.csDuty) === 0.50) {
                                parsedSet.csDuty = 0.18;
                            }
                        }
                        parsedSet.csMode = parsedSet.csMode === 'manual' ? 'manual' : 'auto';
                        if (parsedSet.csDuty === undefined) parsedSet.csDuty = 0.18;
                        const savedCsDuty = Number(parsedSet.csDuty);
                        parsedSet.csDuty = Number.isFinite(savedCsDuty)
                            ? Math.min(0.60, Math.max(0.05, savedCsDuty))
                            : 0.18;
                        if (parsedSet.role === undefined) parsedSet.role = 'admin';
                        if (parsedSet.categoryOrderCustom === undefined) parsedSet.categoryOrderCustom = false;
                        if (parsedSet.backupIntervalDays === undefined) parsedSet.backupIntervalDays = 7;
                        Object.assign(appSettings, parsedSet);
                        if (legacyCsSettings) {
                            localStorage.setItem('hev_app_settings', JSON.stringify(appSettings));
                        }
                    }

                    sortCategories();
                    normalizeSubItems();
                    migrateLegacyLabels();
                    loadOpLogs();
                    saveData();

                    try {
                        const rawSnap = localStorage.getItem('hev_snapshot_latest');
                        renameSnapshot.value = rawSnap ? JSON.parse(rawSnap) : null;
                    } catch (e) {
                        renameSnapshot.value = null;
                    }
                };

                // 最近一次本地保存时间，用于设置页“已自动保存”与备份区状态展示
                const lastSavedAt = ref(Number(localStorage.getItem('hev_last_saved_at')) || null);
                const markSaved = () => {
                    const now = Date.now();
                    lastSavedAt.value = now;
                    try { localStorage.setItem('hev_last_saved_at', String(now)); } catch (e) { /* 忽略存储异常 */ }
                };

                const saveData = () => {
                    localStorage.setItem('hev_vehicles', JSON.stringify(vehicles.value));
                    localStorage.setItem('hev_categories', JSON.stringify(categories.value));
                    localStorage.setItem('hev_records', JSON.stringify(records.value));
                    markSaved();
                };

                const saveSettings = () => {
                    localStorage.setItem('hev_app_settings', JSON.stringify(appSettings));
                    markSaved();
                    updateCharts();
                };

                // 切换为只读前二次确认，取消时回退到原角色（S8）
                const roleBeforeChange = ref(appSettings.role || 'admin');
                const handleRoleChange = (val) => {
                    if (val === 'viewer' && roleBeforeChange.value !== 'viewer') {
                        ElementPlus.ElMessageBox.confirm(
                            '切换为“只读”后将不能新增、编辑或删除记录，仍可随时切回。确认切换？',
                            '切换为只读',
                            { type: 'warning', confirmButtonText: '确认切换', cancelButtonText: '取消' }
                        ).then(() => {
                            roleBeforeChange.value = 'viewer';
                            saveSettings();
                        }).catch(() => {
                            appSettings.role = roleBeforeChange.value;
                        });
                        return;
                    }
                    roleBeforeChange.value = val;
                    saveSettings();
                };

                const openCategorySort = () => {
                    if (!requireManage()) return;
                    sortDraft.value = categories.value.slice();
                    sortDialogVisible.value = true;
                };
                const moveCategory = (idx, delta) => {
                    const to = idx + delta;
                    if (to < 0 || to >= sortDraft.value.length) return;
                    const arr = sortDraft.value.slice();
                    [arr[idx], arr[to]] = [arr[to], arr[idx]];
                    sortDraft.value = arr;
                };
                const saveCategoryOrder = () => {
                    if (!requireManage()) return;
                    categories.value = sortDraft.value.slice();
                    appSettings.categoryOrderCustom = true;
                    saveData();
                    saveSettings();
                    sortDialogVisible.value = false;
                    ElementPlus.ElMessage.success('类别顺序已保存');
                };
                const resetCategoryOrder = () => {
                    if (!requireManage()) return;
                    appSettings.categoryOrderCustom = false;
                    sortCategories(true);
                    sortDraft.value = categories.value.slice();
                    saveData();
                    saveSettings();
                    ElementPlus.ElMessage.success('已恢复固定顺序');
                };

                const handleVehicleChange = () => {
                    currentPage.value = 1; 
                    if (currentCategory.value && currentCategory.value.requireMileage) prefillLatestMileage();
                    nextTick(() => { updateCharts(); });
                };

                const addVehicle = () => {
                    ElementPlus.ElMessageBox.prompt('请输入车辆名称', '新增车辆', { confirmButtonText: '确定', cancelButtonText: '取消' })
                        .then(({ value }) => {
                            if (value && value.trim() !== '') {
                                vehicles.value.push({ id: 'v_' + Date.now(), name: value.trim() });
                                saveData();
                            }
                        }).catch(() => {});
                };

                const editVehicle = (index) => {
                    const v = vehicles.value[index];
                    ElementPlus.ElMessageBox.prompt('请输入新的车辆名称', '编辑车辆', {
                        confirmButtonText: '确定', cancelButtonText: '取消', inputValue: v.name
                    }).then(({ value }) => {
                        if (value && value.trim() !== '') {
                            v.name = value.trim();
                            saveData();
                            ElementPlus.ElMessage.success('车辆名称已更新');
                        }
                    }).catch(() => {});
                };

                const deleteVehicle = (index) => { 
                    const v = vehicles.value[index];
                    ElementPlus.ElMessageBox.confirm(`确定删除车辆 "${v.name}" 吗？该车辆下的所有记录将被清空！`, '警告', { type: 'warning' })
                        .then(() => {
                            const wasCurrent = currentVehicleId.value === v.id;
                            records.value = records.value.filter(r => r.vehicleId !== v.id); 
                            vehicles.value.splice(index, 1); 
                            if (wasCurrent) {
                                currentVehicleId.value = vehicles.value[0].id;
                                handleVehicleChange();
                            }
                            saveData();
                            // 删除当前车辆后明确告知已切换到哪一辆（S11）
                            ElementPlus.ElMessage.success(wasCurrent
                                ? `已删除车辆「${v.name}」，已切换到「${currentVehicleName.value}」`
                                : `已删除车辆「${v.name}」`);
                        }).catch(() => {});
                };

                // 切换排序方式后回到第一页，避免停留在越界页码
                const handleRecordSortModeChange = () => {
                    currentPage.value = 1;
                };

                const handleRecordTypeChange = () => {
                    form.categoryId = ''; form.categoryName = ''; form.subCategory = ''; form.subCategoryList = [];
                    form.liters = 0; form.kwh = null;
                    form.startSoc = null; form.endSoc = null;
                    form.kwhSource = null;
                    applyDefaultCategory();
                };

                const applyDefaultCategory = () => {
                    const targetName = form.recordType === 'income' ? '顺风车' : '充电';
                    const target = categories.value.find(c => c.type === form.recordType && c.name === targetName);
                    const fallback = categories.value.find(c => c.type === form.recordType);
                    const cat = target || fallback;
                    form.categoryId = cat ? cat.id : '';
                    form.subCategory = '';
                    form.subCategoryList = [];
                    handleCategoryChange(form.categoryId);
                };

                const handleCategoryChange = (val) => {
                    form.subCategory = '';
                    form.subCategoryList = [];
                    const cat = categories.value.find(c => c.id === val);
                    form.categoryName = cat ? cat.name : '';
                    if(cat && cat.name !== '加油') form.liters = 0;
                    if(cat && cat.name !== '充电') form.kwh = null;

                    // SOC 仅对充电类别生效：进入充电时终止 SOC 默认 100，其余类别清空
                    if (cat && cat.name === '充电') {
                        form.startSoc = null;
                        form.endSoc = 100;
                        form.kwhSource = 'pile';
                    } else {
                        form.startSoc = null;
                        form.endSoc = null;
                        form.kwhSource = null;
                    }
                    
                    if(cat && !cat.requireMileage) { form.hev = 0; form.ev = 0; form.totalMileage = 0; }
                    else if (cat && cat.requireMileage) prefillLatestMileage();
                };

                // ==================== 充电 SOC 字段（选填，0-100 整数） ====================
                const socFieldLabels = { startSoc: '起始SOC(%)', endSoc: '终止SOC(%)' };

                // 输入阶段仅保留数字字符，避免小数、负号、字母等非法内容
                const applySocInput = (target, key, val) => {
                    target[key] = String(val === null || val === undefined ? '' : val).replace(/\D/g, '').slice(0, 3);
                };

                // 空值视为未填写；超出 0-100 时提示并修正到最近的边界值
                const validateSocOn = (target, key) => {
                    const raw = String(target[key] === null || target[key] === undefined ? '' : target[key]).trim();
                    if (raw === '') { target[key] = null; return; }
                    const num = parseInt(raw, 10);
                    if (isNaN(num)) { target[key] = null; return; }
                    if (num < 0 || num > 100) {
                        const fixed = Math.min(100, Math.max(0, num));
                        target[key] = fixed;
                        ElementPlus.ElMessage.warning(`${socFieldLabels[key]}需为 0-100 之间的整数，已自动修正为 ${fixed}`);
                        return;
                    }
                    target[key] = num;
                };

                const handleSocInput = (key, val) => applySocInput(form, key, val);
                const validateSoc = (key) => validateSocOn(form, key);
                const handleEditSocInput = (key, val) => applySocInput(editForm, key, val);
                const validateEditSoc = (key) => validateSocOn(editForm, key);

                // 新增记录金额/升数默认显示 0.00：聚焦时若仍为默认值则全选，直接键入即可替换
                const selectDefaultNumberOnFocus = (event) => {
                    const input = event && event.target;
                    if (!input || input.tagName !== 'INPUT') return;
                    if (Number(input.value) !== 0) return;
                    // 延后到点击定位光标之后执行，避免选区被鼠标事件覆盖
                    setTimeout(() => {
                        if (document.activeElement === input) {
                            try { input.select(); } catch (e) { /* 忽略选区异常 */ }
                        }
                    }, 0);
                };

                // 持久化前统一转为整数或 null，保证旧记录与字符串输入都不会写入脏数据
                const toSocInt = (val) => {
                    if (val === null || val === undefined || String(val).trim() === '') return null;
                    const num = parseInt(val, 10);
                    if (isNaN(num)) return null;
                    return Math.min(100, Math.max(0, num));
                };

                const requireEdit = () => {
                    if (canEdit.value) return true;
                    ElementPlus.ElMessage.warning('当前为只读角色，无法修改记录');
                    return false;
                };
                const requireManage = () => {
                    if (canManage.value) return true;
                    ElementPlus.ElMessage.warning('仅管理员可维护标签与类别');
                    return false;
                };

                const saveRecord = () => {
                    if (!requireEdit()) return;
                    if (!form.date || !form.categoryId || !currentVehicleId.value) {
                        ElementPlus.ElMessage.error('日期、记录类别和车辆归属为必填项！');
                        return;
                    }
                    // 保养项目支持多选：保存时合并为字符串，保持原有记录结构与图表分组规则
                    if (form.categoryName === '保养') {
                        form.subCategory = (form.subCategoryList || []).join('、');
                    }
                    const newRecord = { ...form, id: Date.now().toString(), vehicleId: currentVehicleId.value };
                    delete newRecord.subCategoryList;
                    newRecord.remark = String(form.remark || '').trim();
                    if (form.categoryName !== '充电') {
                        newRecord.kwh = null;
                        newRecord.kwhSource = null;
                        newRecord.startSoc = null;
                        newRecord.endSoc = null;
                    } else {
                        newRecord.startSoc = toSocInt(form.startSoc);
                        newRecord.endSoc = toSocInt(form.endSoc);
                        // 电量口径仅在有充电量时记录，默认桩端
                        const hasKwh = typeof newRecord.kwh === 'number' && !isNaN(newRecord.kwh) && newRecord.kwh > 0;
                        newRecord.kwhSource = hasKwh ? (form.kwhSource === 'vehicle' ? 'vehicle' : 'pile') : null;
                    }
                    // 双写：保留展示文本，同时记录稳定标签 ID，供后续改名/合并使用
                    const catObj = categories.value.find(c => c.id === form.categoryId);
                    const selectedNames = String(newRecord.subCategory || '').split('、').filter(Boolean);
                    newRecord.subCategoryIds = catObj
                        ? catObj.subItems.filter(s => selectedNames.includes(s.name)).map(s => s.id)
                        : [];
                    // 新增记录默认置于列表顶部（按添加时间倒序）
                    records.value.unshift(newRecord);
                    currentPage.value = 1;
                    saveData();
                    ElementPlus.ElMessage.success('记录保存成功！');
                    if (form.categoryName && requiresMileage(form.categoryName)) prefillLatestMileage();
                    updateCharts();
                };

                const deleteRecord = (id) => {
                    if (!requireEdit()) return;
                    records.value = records.value.filter(r => r.id !== id);
                    saveData();
                    ElementPlus.ElMessage.success('已删除记录');
                    updateCharts();
                };

                // ==================== 记录拖拽排序 ====================
                const recordsTableWrap = ref(null);
                const draggingId = ref('');
                const draggingDate = ref('');
                const dragOverId = ref('');
                const dragOverPos = ref(''); // 'before' | 'after'

                const resetDragState = () => {
                    draggingId.value = '';
                    draggingDate.value = '';
                    dragOverId.value = '';
                    dragOverPos.value = '';
                };

                const recordRowClassName = ({ row }) => {
                    if (row.id === draggingId.value) return 'drag-row-dragging';
                    if (row.id === dragOverId.value) {
                        return dragOverPos.value === 'after'
                            ? 'drag-row-over drag-row-over-after'
                            : 'drag-row-over drag-row-over-before';
                    }
                    return '';
                };

                const onDragStart = (event, row) => {
                    if (!canEdit.value) {
                        event.preventDefault();
                        ElementPlus.ElMessage.warning('当前为只读角色，无法调整顺序');
                        return;
                    }
                    draggingId.value = row.id;
                    draggingDate.value = row.date || '';
                    dragOverId.value = '';
                    dragOverPos.value = '';
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'move';
                        try { event.dataTransfer.setData('text/plain', String(row.id)); } catch (e) {}
                    }
                };

                const onDragEnd = () => resetDragState();

                // 分组表格按日期渲染：先定位事件所属分组，再按行号映射到记录，
                // 同时根据鼠标位于行内上半/下半，决定插入到目标记录之前还是之后
                const getRowDropInfoFromEvent = (event) => {
                    const target = event.target;
                    if (!(target instanceof Element)) return null;
                    const groupEl = target.closest('[data-records-group]');
                    if (!groupEl) return null;
                    const group = groupedRecords.value[Number(groupEl.getAttribute('data-records-group'))];
                    if (!group) return null;
                    const tr = target.closest('tr.el-table__row');
                    if (!tr || !tr.parentElement) return null;
                    const idx = Array.prototype.indexOf.call(tr.parentElement.children, tr);
                    const row = group.records[idx];
                    if (!row) return null;
                    const rect = tr.getBoundingClientRect();
                    return { row, after: event.clientY > rect.top + rect.height / 2 };
                };

                // 同一日期分组内可自由拖拽（含里程记录），跨日期分组不可放置
                const canDropOnRow = (row) => {
                    if (!row || row.id === draggingId.value) return false;
                    return (row.date || '') === draggingDate.value;
                };

                const handleTableDragOver = (event) => {
                    if (!draggingId.value) return;
                    const info = getRowDropInfoFromEvent(event);
                    if (!info) return;
                    if (!canDropOnRow(info.row)) {
                        // 拖到其他日期分组时清除高亮，避免残留指示
                        if (dragOverId.value) {
                            dragOverId.value = '';
                            dragOverPos.value = '';
                        }
                        return;
                    }
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    const pos = info.after ? 'after' : 'before';
                    // 仅在目标行或插入位置变化时更新响应式状态，避免拖动过程中的无效重渲染
                    if (dragOverId.value === info.row.id && dragOverPos.value === pos) return;
                    dragOverId.value = info.row.id;
                    dragOverPos.value = pos;
                };

                const handleTableDragLeave = (event) => {
                    const wrap = recordsTableWrap.value;
                    if (wrap && event.relatedTarget && wrap.contains(event.relatedTarget)) return;
                    dragOverId.value = '';
                    dragOverPos.value = '';
                };

                const handleTableDrop = (event) => {
                    if (!draggingId.value) return;
                    // 拖拽进行中一律阻止浏览器默认行为（如按文本打开搜索结果）
                    event.preventDefault();
                    const info = getRowDropInfoFromEvent(event);
                    if (!info || !canDropOnRow(info.row)) {
                        resetDragState();
                        return;
                    }
                    const fromId = draggingId.value;
                    const toId = info.row.id;
                    const position = info.after ? 'after' : 'before';
                    resetDragState();
                    moveRecord(fromId, toId, position);
                };

                // 里程倒序是展示层的临时排序：拖拽前先把当前展示顺序固化为该日期组的手动顺序，
                // 再切回“添加时间”，保证拖拽结果与用户所见一致
                const freezeDateGroupDisplayOrder = (date) => {
                    const slots = [];
                    records.value.forEach((r, i) => { if ((r.date || '') === date) slots.push(i); });
                    if (!slots.length) return;
                    const displayed = sortedTableRecords.value.filter(r => (r.date || '') === date);
                    const shownIds = new Set(displayed.map(r => r.id));
                    const hidden = slots.map(i => records.value[i]).filter(r => !shownIds.has(r.id));
                    const ordered = displayed.concat(hidden);
                    const next = records.value.slice();
                    ordered.forEach((r, idx) => { next[slots[idx]] = r; });
                    records.value = next;
                };

                // 将记录插入到目标记录之前/之后，并立即持久化，保证刷新后顺序一致
                const moveRecord = (fromId, toId, position) => {
                    if (!requireEdit()) return;
                    if (fromId === toId) return;
                    const fromRec = records.value.find(r => r.id === fromId);
                    const toRec = records.value.find(r => r.id === toId);
                    if (!fromRec || !toRec) return;
                    const switchedFromMileage = recordSortMode.value === 'mileage';
                    if (switchedFromMileage) {
                        freezeDateGroupDisplayOrder(fromRec.date || '');
                        recordSortMode.value = 'time';
                    }
                    const list = records.value.slice();
                    const from = list.findIndex(r => r.id === fromId);
                    if (from < 0) return;
                    const [moved] = list.splice(from, 1);
                    // 移除源记录后目标索引可能前移，需重新定位
                    const target = list.findIndex(r => r.id === toId);
                    if (target < 0) return;
                    list.splice(position === 'after' ? target + 1 : target, 0, moved);
                    records.value = list;
                    saveData();
                    ElementPlus.ElMessage.success(switchedFromMileage ? '顺序已更新，已切换为添加时间排序' : '顺序已更新');
                };

                // ==================== 单条记录编辑 ====================
                const handleEditRecordTypeChange = () => {
                    editForm.categoryId = '';
                    editForm.categoryName = '';
                    editForm.subCategoryList = [];
                    editForm.amount = 0;
                    editForm.liters = 0;
                    editForm.kwh = null;
                    editForm.kwhSource = null;
                    editForm.startSoc = null;
                    editForm.endSoc = null;
                    editForm.hev = 0;
                    editForm.ev = 0;
                    editForm.totalMileage = 0;
                };

                const handleEditCategoryChange = (val) => {
                    const cat = categories.value.find(c => c.id === val);
                    editForm.categoryName = cat ? cat.name : '';
                    editForm.subCategoryList = [];
                    if (!cat || cat.name !== '加油') editForm.liters = 0;
                    if (!cat || cat.name !== '充电') {
                        editForm.kwh = null;
                        editForm.kwhSource = null;
                        editForm.startSoc = null;
                        editForm.endSoc = null;
                    } else {
                        editForm.kwhSource = 'pile';
                        editForm.startSoc = null;
                        editForm.endSoc = 100;
                    }
                    if (!cat || !cat.requireMileage) {
                        editForm.hev = 0;
                        editForm.ev = 0;
                        editForm.totalMileage = 0;
                    }
                };

                const openEditRecord = (row) => {
                    if (!requireEdit()) return;
                    editingId.value = row.id;
                    const kwhValue = (row.kwh === null || row.kwh === undefined || row.kwh === '') ? null : Number(row.kwh);
                    const socValue = (val) => (val === null || val === undefined || val === '') ? null : val;
                    editForm.date = row.date || '';
                    editForm.recordType = row.recordType || 'expense';
                    editForm.categoryId = row.categoryId || '';
                    editForm.categoryName = row.categoryName || '';
                    editForm.subCategoryList = String(row.subCategory || '').split('、').filter(Boolean);
                    editForm.amount = Number(row.amount) || 0;
                    editForm.liters = Number(row.liters) || 0;
                    editForm.kwh = kwhValue;
                    editForm.kwhSource = row.kwhSource || 'pile';
                    editForm.startSoc = socValue(row.startSoc);
                    editForm.endSoc = socValue(row.endSoc);
                    editForm.hev = Number(row.hev) || 0;
                    editForm.ev = Number(row.ev) || 0;
                    editForm.totalMileage = Number(row.totalMileage) || (editForm.hev + editForm.ev);
                    editForm.remark = row.remark || '';
                    editVisible.value = true;
                };

                const saveEditRecord = () => {
                    if (!requireEdit()) return;
                    if (!editForm.date) {
                        ElementPlus.ElMessage.error('请选择日期');
                        return;
                    }
                    if (!editForm.categoryId) {
                        ElementPlus.ElMessage.error('请选择记录类别');
                        return;
                    }
                    const amount = Number(editForm.amount);
                    if (!isFinite(amount) || amount < 0) {
                        ElementPlus.ElMessage.error('请输入有效的金额');
                        return;
                    }
                    const record = records.value.find(r => r.id === editingId.value);
                    if (!record) {
                        ElementPlus.ElMessage.error('记录不存在，可能已被删除');
                        editVisible.value = false;
                        return;
                    }
                    // SOC 输入统一校验，非法值提示并修正后再保存
                    validateSocOn(editForm, 'startSoc');
                    validateSocOn(editForm, 'endSoc');
                    const cat = categories.value.find(c => c.id === editForm.categoryId);
                    const catName = cat ? cat.name : editForm.categoryName;

                    editSaving.value = true;
                    ElementPlus.ElMessageBox.confirm('确认保存对该记录的修改？', '保存确认', {
                        confirmButtonText: '确认保存', cancelButtonText: '取消', type: 'warning'
                    }).then(() => {
                        const names = (editForm.subCategoryList || []).filter(Boolean);
                        record.date = editForm.date;
                        record.recordType = editForm.recordType;
                        record.categoryId = editForm.categoryId;
                        record.categoryName = catName;
                        record.subCategory = names.join('、');
                        record.subCategoryIds = cat
                            ? cat.subItems.filter(s => names.includes(s.name)).map(s => s.id)
                            : [];
                        record.amount = Math.round(amount * 100) / 100;
                        record.remark = String(editForm.remark || '').trim();
                        record.liters = catName === '加油' ? (Number(editForm.liters) || 0) : 0;
                        if (catName === '充电') {
                            const kwh = (typeof editForm.kwh === 'number' && !isNaN(editForm.kwh)) ? editForm.kwh : null;
                            record.kwh = kwh;
                            record.kwhSource = (kwh && kwh > 0) ? (editForm.kwhSource === 'vehicle' ? 'vehicle' : 'pile') : null;
                            record.startSoc = toSocInt(editForm.startSoc);
                            record.endSoc = toSocInt(editForm.endSoc);
                        } else {
                            record.kwh = null;
                            record.kwhSource = null;
                            record.startSoc = null;
                            record.endSoc = null;
                        }
                        if (requiresMileage(catName)) {
                            record.hev = Number(editForm.hev) || 0;
                            record.ev = Number(editForm.ev) || 0;
                            record.totalMileage = Number(editForm.totalMileage) || (record.hev + record.ev);
                        }
                        saveData();
                        editSaving.value = false;
                        editVisible.value = false;
                        ElementPlus.ElMessage.success('记录已更新');
                        updateCharts();
                    }).catch(() => {
                        editSaving.value = false;
                    });
                };

                const saveCategories = () => saveData();

                const addCategory = (type) => {
                    if (!requireManage()) return;
                    const titleName = type === 'income' ? '新增收入类别' : '新增支出类别';
                    ElementPlus.ElMessageBox.prompt(`请输入${titleName}名称`, titleName, { confirmButtonText: '确定', cancelButtonText: '取消' })
                        .then(({ value }) => {
                            if (value && value.trim() !== '') {
                                const name = value.trim();
                                if (categories.value.some(c => c.type === type && c.name === name)) {
                                    ElementPlus.ElMessage.warning(`同类型下已存在名为「${name}」的类别`);
                                    return;
                                }
                                categories.value.push({ id: Date.now().toString(), name: name, type: type, hasSub: false, subItems: [], newSubInput: '', requireMileage: false });
                                sortCategories();
                                saveCategories();
                            }
                        }).catch(() => {});
                };

                const editCategory = (index) => {
                    if (!requireManage()) return;
                    const cat = categories.value[index];
                    const oldName = cat.name;
                    ElementPlus.ElMessageBox.prompt('请输入新的类别名称', '编辑类别', {
                        confirmButtonText: '确定', cancelButtonText: '取消', inputValue: cat.name
                    }).then(({ value }) => {
                        if (value && value.trim() !== '' && value.trim() !== oldName) {
                            const newName = value.trim();
                            if (categories.value.some(c => c.id !== cat.id && c.type === cat.type && c.name === newName)) {
                                ElementPlus.ElMessage.warning(`同类型下已存在名为「${newName}」的类别，请更换名称`);
                                return;
                            }
                            cat.name = newName;
                            records.value.forEach(r => { if (r.categoryId === cat.id) r.categoryName = newName; });
                            if (selectedChartCategory.value === oldName) selectedChartCategory.value = newName;
                            sortCategories();
                            saveCategories(); 
                            ElementPlus.ElMessage.success('类别名称已更新，历史数据已自动同步');
                            updateCharts();
                        }
                    }).catch(() => {});
                };

                // =============== 类别删除：二次确认、迁移或停用（S1） ===============
                const deleteCategoryDialogVisible = ref(false);
                const deleteCategoryIndex = ref(-1);
                const deleteCategoryMode = ref('migrate');
                const deleteCategoryTargetId = ref('');

                // 兼容旧数据：缺少 categoryId 的记录以类别名称匹配
                const recordBelongsToCategory = (r, cat) => r.categoryId ? r.categoryId === cat.id : r.categoryName === cat.name;

                const pendingDeleteCategory = computed(() => categories.value[deleteCategoryIndex.value] || null);
                const deleteCategoryAffected = computed(() => {
                    const cat = pendingDeleteCategory.value;
                    if (!cat) return 0;
                    return records.value.filter(r => recordBelongsToCategory(r, cat)).length;
                });
                const deleteCategoryTargets = computed(() => {
                    const cat = pendingDeleteCategory.value;
                    if (!cat) return [];
                    return activeCategories.value.filter(c => c.id !== cat.id && c.type === cat.type);
                });

                const deleteCategory = (index) => {
                    if (!requireManage()) return;
                    const cat = categories.value[index];
                    if (!cat) return;
                    if (records.value.some(r => recordBelongsToCategory(r, cat))) {
                        deleteCategoryIndex.value = index;
                        deleteCategoryMode.value = 'migrate';
                        deleteCategoryTargetId.value = '';
                        deleteCategoryDialogVisible.value = true;
                        return;
                    }
                    ElementPlus.ElMessageBox.confirm(`确定删除类别「${cat.name}」吗？该类别暂无关联记录。`, '删除类别', {
                        type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消'
                    }).then(() => {
                        categories.value.splice(index, 1);
                        if (tableFilter.categoryId === cat.id) tableFilter.categoryId = '';
                        saveCategories();
                        appendOperationLog({
                            action: 'delete-category', categoryId: cat.id, categoryName: cat.name,
                            oldName: cat.name, newName: '', affectedRecords: 0, result: 'success'
                        });
                        ElementPlus.ElMessage.success('类别已删除');
                    }).catch(() => {});
                };

                const confirmDeleteCategory = () => {
                    if (!requireManage()) return;
                    const cat = pendingDeleteCategory.value;
                    const index = deleteCategoryIndex.value;
                    if (!cat) { deleteCategoryDialogVisible.value = false; return; }
                    const affected = deleteCategoryAffected.value;
                    if (deleteCategoryMode.value === 'deactivate') {
                        cat.active = false;
                        deleteCategoryDialogVisible.value = false;
                        if (tableFilter.categoryId === cat.id) tableFilter.categoryId = '';
                        saveCategories();
                        appendOperationLog({
                            action: 'deactivate-category', categoryId: cat.id, categoryName: cat.name,
                            oldName: cat.name, newName: '', affectedRecords: affected, result: 'success'
                        });
                        ElementPlus.ElMessage.success('类别已停用，历史记录与图表保持不变');
                        return;
                    }
                    const target = categories.value.find(c => c.id === deleteCategoryTargetId.value && c.id !== cat.id);
                    if (!target) { ElementPlus.ElMessage.warning('请选择迁移的目标类别'); return; }
                    records.value.forEach(r => {
                        if (!recordBelongsToCategory(r, cat)) return;
                        r.categoryId = target.id;
                        r.categoryName = target.name;
                        if (Array.isArray(r.subCategoryIds)) {
                            const targetIds = new Set((target.subItems || []).map(s => s.id));
                            r.subCategoryIds = r.subCategoryIds.filter(id => targetIds.has(id));
                        }
                    });
                    categories.value.splice(index, 1);
                    deleteCategoryDialogVisible.value = false;
                    if (tableFilter.categoryId === cat.id) tableFilter.categoryId = '';
                    saveCategories();
                    if (selectedChartCategory.value === cat.name) selectedChartCategory.value = target.name;
                    updateCharts();
                    appendOperationLog({
                        action: 'migrate-category', categoryId: cat.id, categoryName: cat.name,
                        oldName: cat.name, newName: target.name, affectedRecords: affected, result: 'success'
                    });
                    ElementPlus.ElMessage.success(`已删除类别「${cat.name}」，${affected} 条记录迁移到「${target.name}」`);
                };

                const enableCategory = (index) => {
                    if (!requireManage()) return;
                    const cat = categories.value[index];
                    if (!cat || cat.active !== false) return;
                    cat.active = true;
                    saveCategories();
                    appendOperationLog({
                        action: 'reactivate-category', categoryId: cat.id, categoryName: cat.name,
                        oldName: cat.name, newName: '', affectedRecords: 0, result: 'success'
                    });
                    ElementPlus.ElMessage.success('类别已启用');
                };

                const addSubItem = (row) => {
                    if (!requireManage()) return;
                    const name = String(row.newSubInput || '').trim();
                    if (!name) return;
                    if (name.length > 20) return ElementPlus.ElMessage.warning('标签名称不能超过 20 个字符');
                    if (name.includes('、')) return ElementPlus.ElMessage.warning('标签名称不能包含“、”');
                    if ((row.subItems || []).some(s => s.name === name)) return ElementPlus.ElMessage.warning('该标签已存在');
                    row.subItems.push({ id: makeSubId(), name, active: true, aliases: [] });
                    row.newSubInput = '';
                    saveCategories();
                };
                // 标签操作快照：重命名/合并/删除前统一保存，供“撤销上次标签操作”恢复
                const saveTagSnapshot = (cat, tag, oldName, newName, affected, action) => {
                    const snapshot = {
                        ts: Date.now(),
                        action: action || 'tag-rename',
                        categoryId: cat.id,
                        categoryName: cat.name,
                        tagId: tag.id,
                        oldName,
                        newName,
                        affectedRecords: affected,
                        categories: JSON.parse(JSON.stringify(categories.value)),
                        records: JSON.parse(JSON.stringify(records.value))
                    };
                    localStorage.setItem('hev_snapshot_latest', JSON.stringify(snapshot));
                    renameSnapshot.value = snapshot;
                    return snapshot;
                };

                const removeSubItem = (row, tagId) => {
                    if (!requireManage()) return;
                    const tag = (row.subItems || []).find(s => s.id === tagId);
                    if (!tag) return;
                    const affected = records.value.filter(r =>
                        r.categoryId === row.id && String(r.subCategory || '').split('、').includes(tag.name)
                    ).length;
                    const tip = affected > 0
                        ? `删除标签「${tag.name}」？当前有 ${affected} 条历史记录使用该标签，记录内容保持不变；删除后可通过“撤销上次标签操作”恢复。`
                        : `删除标签「${tag.name}」？删除后可通过“撤销上次标签操作”恢复。`;
                    ElementPlus.ElMessageBox.confirm(tip, '删除二级标签', {
                        type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消'
                    }).then(() => {
                        saveTagSnapshot(row, tag, tag.name, '（已删除）', affected, 'tag-delete');
                        row.subItems = row.subItems.filter(s => s.id !== tagId);
                        saveCategories();
                        appendOperationLog({
                            action: 'delete-subtag', categoryId: row.id, categoryName: row.name,
                            tagId: tag.id, oldName: tag.name, newName: '', affectedRecords: affected, result: 'success'
                        });
                        ElementPlus.ElMessage.success('标签已删除，可在操作日志区撤销');
                    }).catch(() => {});
                };

                const applySubItemRename = (cat, tag, oldName, newName, affected) => {
                    try {
                        saveTagSnapshot(cat, tag, oldName, newName, affected, 'tag-rename');

                        tag.name = newName;
                        tag.aliases = Array.from(new Set([...(tag.aliases || []), oldName]));

                        records.value.forEach(r => {
                            if (r.categoryId !== cat.id || !r.subCategory) return;
                            const tokens = String(r.subCategory).split('、');
                            if (!tokens.includes(oldName)) return;
                            r.subCategory = tokens.map(t => t === oldName ? newName : t).join('、');
                            if (Array.isArray(r.subCategoryIds) && !r.subCategoryIds.includes(tag.id)) {
                                r.subCategoryIds.push(tag.id);
                            }
                        });

                        saveData();
                        appendOperationLog({
                            action: 'rename-subtag',
                            categoryId: cat.id,
                            categoryName: cat.name,
                            tagId: tag.id,
                            oldName,
                            newName,
                            affectedRecords: affected,
                            result: 'success'
                        });
                        updateCharts();
                        ElementPlus.ElMessage.success(`已重命名为“${newName}”，同步 ${affected} 条历史记录`);
                    } catch (e) {
                        ElementPlus.ElMessage.error('重命名失败：' + e.message);
                    }
                };

                const renameSubItem = (cat, tag) => {
                    if (!requireManage()) return;
                    ElementPlus.ElMessageBox.prompt('重命名后，历史记录中的同名标签会同步更新，金额与统计口径不变。', '编辑二级标签', {
                        inputValue: tag.name,
                        confirmButtonText: '下一步',
                        cancelButtonText: '取消',
                        inputValidator: (val) => {
                            const name = String(val || '').trim();
                            if (!name) return '标签名称不能为空';
                            if (name.length > 20) return '标签名称不能超过 20 个字符';
                            if (name.includes('、')) return '标签名称不能包含“、”';
                            if ((cat.subItems || []).some(s => s.id !== tag.id && s.name === name)) return '同类别下已存在该标签';
                            return true;
                        }
                    }).then(({ value }) => {
                        const newName = String(value || '').trim();
                        const oldName = tag.name;
                        if (newName === oldName) return;

                        const affected = records.value.filter(r =>
                            r.categoryId === cat.id &&
                            String(r.subCategory || '').split('、').includes(oldName)
                        ).length;

                        const tip = affected > 0
                            ? `将同步更新 ${affected} 条历史记录中的“${oldName}”为“${newName}”，金额与统计口径不变。是否继续？`
                            : '该标签暂无历史记录，是否继续重命名？';

                        ElementPlus.ElMessageBox.confirm(tip, '确认重命名', {
                            type: 'warning',
                            confirmButtonText: '确认修改',
                            cancelButtonText: '取消'
                        }).then(() => {
                            applySubItemRename(cat, tag, oldName, newName, affected);
                        }).catch(() => {});
                    }).catch(() => {});
                };

                const undoLastRename = () => {
                    if (!requireManage()) return;
                    const snap = renameSnapshot.value;
                    if (!snap || !Array.isArray(snap.categories) || !Array.isArray(snap.records)) return;
                    ElementPlus.ElMessageBox.confirm(
                        `将恢复操作前的标签与记录，并回滚之后的其它改动。确认撤销“${snap.oldName} → ${snap.newName}”？`,
                        '撤销标签操作',
                        { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '取消' }
                    ).then(() => {
                        categories.value = snap.categories;
                        records.value = snap.records;
                        saveData();
                        appendOperationLog({
                            action: 'undo-rename',
                            categoryId: snap.categoryId,
                            categoryName: snap.categoryName,
                            tagId: snap.tagId,
                            oldName: snap.newName,
                            newName: snap.oldName,
                            affectedRecords: snap.affectedRecords,
                            result: 'success'
                        });
                        localStorage.removeItem('hev_snapshot_latest');
                        renameSnapshot.value = null;
                        updateCharts();
                        ElementPlus.ElMessage.success('已撤销上次标签操作');
                    }).catch(() => {});
                };

                // =============== 标签合并 / 停用（P3） ===============
                const tagOpsVisible = ref(false);
                const tagOps = reactive({ categoryId: '', sourceId: '', targetId: '', action: 'merge' });
                const tagOpsCategory = computed(() => categories.value.find(c => c.id === tagOps.categoryId) || null);
                const tagOpsTags = computed(() => tagOpsCategory.value ? tagOpsCategory.value.subItems : []);
                const tagOpsTargets = computed(() => tagOpsTags.value.filter(t => t.id !== tagOps.sourceId));
                const tagOpsSource = computed(() => tagOpsTags.value.find(t => t.id === tagOps.sourceId) || null);
                const tagOpsAffected = computed(() => {
                    if (!tagOpsSource.value) return 0;
                    return records.value.filter(r =>
                        r.categoryId === tagOps.categoryId &&
                        String(r.subCategory || '').split('、').includes(tagOpsSource.value.name)
                    ).length;
                });

                const openTagOpsDialog = () => {
                    if (!requireManage()) return;
                    const first = subCategories.value[0];
                    tagOps.categoryId = first ? first.id : '';
                    tagOps.sourceId = '';
                    tagOps.targetId = '';
                    tagOps.action = 'merge';
                    tagOpsVisible.value = true;
                };

                const onTagOpsCategoryChange = () => {
                    tagOps.sourceId = '';
                    tagOps.targetId = '';
                };

                const onTagClick = (cat, tag) => {
                    if (!requireManage()) return;
                    if (tag.active === false) {
                        ElementPlus.ElMessageBox.confirm(`启用标签“${tag.name}”？启用后可再次用于新记录。`, '启用标签', {
                            type: 'info', confirmButtonText: '启用', cancelButtonText: '取消'
                        }).then(() => {
                            tag.active = true;
                            saveCategories();
                            appendOperationLog({
                                action: 'reactivate-subtag', categoryId: cat.id, categoryName: cat.name,
                                tagId: tag.id, oldName: tag.name, newName: tag.name, affectedRecords: 0, result: 'success'
                            });
                            ElementPlus.ElMessage.success('标签已启用');
                        }).catch(() => {});
                        return;
                    }
                    renameSubItem(cat, tag);
                };

                const applyTagMerge = (cat, src, tgt, affected) => {
                    try {
                        const snapshot = {
                            ts: Date.now(),
                            action: 'tag-merge',
                            categoryId: cat.id,
                            categoryName: cat.name,
                            tagId: src.id,
                            oldName: src.name,
                            newName: tgt.name,
                            affectedRecords: affected,
                            categories: JSON.parse(JSON.stringify(categories.value)),
                            records: JSON.parse(JSON.stringify(records.value))
                        };
                        localStorage.setItem('hev_snapshot_latest', JSON.stringify(snapshot));
                        renameSnapshot.value = snapshot;

                        records.value.forEach(r => {
                            if (r.categoryId !== cat.id || !r.subCategory) return;
                            const tokens = String(r.subCategory).split('、');
                            if (!tokens.includes(src.name)) return;
                            const merged = [];
                            tokens.forEach(t => {
                                const v = t === src.name ? tgt.name : t;
                                if (!merged.includes(v)) merged.push(v);
                            });
                            r.subCategory = merged.join('、');
                            if (Array.isArray(r.subCategoryIds)) {
                                r.subCategoryIds = Array.from(new Set(
                                    r.subCategoryIds.map(id => id === src.id ? tgt.id : id)
                                ));
                            }
                        });

                        src.active = false;
                        src.aliases = Array.from(new Set([...(src.aliases || []), src.name]));
                        tgt.aliases = Array.from(new Set([...(tgt.aliases || []), src.name]));

                        saveData();
                        appendOperationLog({
                            action: 'merge-subtag', categoryId: cat.id, categoryName: cat.name,
                            tagId: src.id, oldName: src.name, newName: tgt.name,
                            affectedRecords: affected, result: 'success'
                        });
                        tagOpsVisible.value = false;
                        updateCharts();
                        ElementPlus.ElMessage.success(`已将“${src.name}”合并到“${tgt.name}”，同步 ${affected} 条记录`);
                    } catch (e) {
                        ElementPlus.ElMessage.error('合并失败：' + e.message);
                    }
                };

                const runTagOps = () => {
                    if (!requireManage()) return;
                    const cat = tagOpsCategory.value;
                    const src = tagOpsSource.value;
                    if (!cat || !src) return ElementPlus.ElMessage.warning('请选择类别和源标签');

                    if (tagOps.action === 'merge') {
                        const tgt = cat.subItems.find(t => t.id === tagOps.targetId);
                        if (!tgt) return ElementPlus.ElMessage.warning('请选择目标标签');
                        if (tgt.id === src.id) return ElementPlus.ElMessage.warning('目标标签不能与源标签相同');
                        const affected = tagOpsAffected.value;
                        ElementPlus.ElMessageBox.confirm(
                            `将“${src.name}”合并到“${tgt.name}”，同步 ${affected} 条历史记录；源标签将停用。是否继续？`,
                            '确认合并', { type: 'warning', confirmButtonText: '确认合并', cancelButtonText: '取消' }
                        ).then(() => applyTagMerge(cat, src, tgt, affected)).catch(() => {});
                        return;
                    }

                    if (src.active === false) return ElementPlus.ElMessage.warning('该标签已是停用状态');
                    const affected = tagOpsAffected.value;
                    ElementPlus.ElMessageBox.confirm(
                        `停用“${src.name}”？停用后不再出现在新记录下拉，${affected} 条历史记录的展示与统计不受影响。`,
                        '确认停用', { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' }
                    ).then(() => {
                        src.active = false;
                        saveCategories();
                        appendOperationLog({
                            action: 'deactivate-subtag', categoryId: cat.id, categoryName: cat.name,
                            tagId: src.id, oldName: src.name, newName: '', affectedRecords: affected, result: 'success'
                        });
                        tagOpsVisible.value = false;
                        ElementPlus.ElMessage.success('标签已停用');
                    }).catch(() => {});
                };

                // =============== 图表逻辑 ===============
                let gasChart, evChart, costChart, totalEnergyChart, mileageChart;
                let chartCategoryPie, chartCategoryTrend, chartEvRatio, chartSubCategoryPie; 
                // 当前图表时间窗内的实际 CS 里程占比（百分比），供设置页与油耗图表副标题展示
                const gasActualEta = ref(null);

                const initCharts = () => {
                    if (document.getElementById('chartGas')) {
                        gasChart = echarts.init(document.getElementById('chartGas'));
                        evChart = echarts.init(document.getElementById('chartEv'));
                        totalEnergyChart = echarts.init(document.getElementById('chartTotalEnergy'));
                        costChart = echarts.init(document.getElementById('chartCost'));
                        mileageChart = echarts.init(document.getElementById('chartMileage'));
                        chartEvRatio = echarts.init(document.getElementById('chartEvRatio'));
                        
                        chartCategoryPie = echarts.init(document.getElementById('chartCategoryPie'));
                        if(document.getElementById('chartSubCategoryPie')) chartSubCategoryPie = echarts.init(document.getElementById('chartSubCategoryPie'));
                        chartCategoryTrend = echarts.init(document.getElementById('chartCategoryTrend'));
                        updateCharts();
                    }
                };

                const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

                // 时间尺度规则（全部基于自然月边界，不使用 30/365 天近似）：
                // 全部     -> 全历史，按自然月聚合，周期键 YYYY-MM
                // 今年     -> 当前自然年（1 月 1 日起），按自然月聚合，周期键 YYYY-MM
                // 年       -> 按自然年聚合，1 月 1 日至 12 月 31 日，周期键 YYYY年
                // 季度     -> 按自然季度聚合，Q1(1-3)/Q2(4-6)/Q3(7-9)/Q4(10-12)，周期键 YYYYQn
                // 近一年   -> 向前推 12 个自然月（含当前月），按自然月聚合，周期键 YYYY-MM
                // 近半年   -> 向前推 6 个自然月（含当前月），按自然月聚合，周期键 YYYY-MM
                const getPeriodKey = (dateStr, scale = chartPeriod.value) => {
                    const year = dateStr.substring(0, 4);
                    const month = parseInt(dateStr.substring(5, 7), 10);
                    if (scale === 'year') return year + '年';
                    if (scale === 'quarter') return year + 'Q' + Math.ceil(month / 3);
                    return dateStr.substring(0, 7);
                };

                // 全部/年/季度为全历史（不设窗口）；今年从 1 月 1 日起；近一年/近半年起点对齐自然月首日
                const getWindowStart = (scale = chartPeriod.value, now = new Date()) => {
                    if (scale === 'thisyear') return new Date(now.getFullYear(), 0, 1);
                    if (scale === 'last12months') return new Date(now.getFullYear(), now.getMonth() - 11, 1);
                    if (scale === 'last6months') return new Date(now.getFullYear(), now.getMonth() - 5, 1);
                    return null;
                };

                // 边界自检：跨年、月初/月末、闰年 2 月，失败时仅告警不影响渲染
                const validateTimeScaleBoundaries = () => {
                    const failed = [];
                    [['2026-12-31', 'year', '2026年'], ['2027-01-01', 'year', '2027年'],
                     ['2026-03-31', 'quarter', '2026Q1'], ['2026-04-01', 'quarter', '2026Q2'],
                     ['2026-12-31', 'quarter', '2026Q4'], ['2027-01-01', 'quarter', '2027Q1'],
                     ['2026-01-01', 'all', '2026-01'], ['2026-12-31', 'thisyear', '2026-12'],
                     ['2026-02-28', 'last12months', '2026-02'], ['2024-02-29', 'last6months', '2024-02']
                    ].forEach(([d, s, expect]) => {
                        const actual = getPeriodKey(d, s);
                        if (actual !== expect) failed.push({ date: d, scale: s, expect, actual });
                    });
                    const w6 = fmtDate(getWindowStart('last6months', new Date(2026, 2, 31)));
                    const w12 = fmtDate(getWindowStart('last12months', new Date(2026, 1, 28)));
                    const wYear = fmtDate(getWindowStart('thisyear', new Date(2026, 11, 31)));
                    if (w6 !== '2025-10-01') failed.push({ scale: 'last6months', expect: '2025-10-01', actual: w6 });
                    if (w12 !== '2025-03-01') failed.push({ scale: 'last12months', expect: '2025-03-01', actual: w12 });
                    if (wYear !== '2026-01-01') failed.push({ scale: 'thisyear', expect: '2026-01-01', actual: wYear });
                    if (failed.length) console.warn('时间尺度边界校验未通过：', failed);
                };

                // 统一图表配色：4 个语义色 + 1 个中性色，固定 Hex，避免渐变与屏幕相关的色彩偏差
                // 蓝=费用/里程/金额，绿=充电成本/纯电，琥珀=油耗，紫=CS折算/衍生指标，灰=参考线
                const CHART = {
                    blue: '#3B82F6',
                    green: '#10B981',
                    amber: '#F59E0B',
                    violet: '#8B5CF6',
                    slate: '#94A3B8',
                    axis: '#E5E7EB',
                    split: '#F1F5F9',
                    label: '#6B7280'
                };
                const CHART_PIE_COLORS = [CHART.blue, CHART.green, CHART.amber, CHART.violet, CHART.slate];
                const chartTooltipBase = {
                    backgroundColor: '#FFFFFF',
                    borderColor: CHART.axis,
                    borderWidth: 1,
                    textStyle: { color: '#374151', fontSize: 11 },
                    extraCssText: 'box-shadow: 0 4px 12px rgba(15,23,42,0.08);'
                };
                const chartPoint = { showSymbol: true, symbol: 'circle', symbolSize: 5 };
                const chartYAxis = {
                    type: 'value',
                    axisLine: { show: false },
                    axisTick: { show: false },
                    axisLabel: { color: CHART.label, fontSize: 10 },
                    splitLine: { lineStyle: { color: CHART.split, type: 'dashed' } }
                };
                // 窄屏标记：仅用于图表标题/图例排布与日期范围面板形态，不影响任何统计逻辑
                const isCompact = ref(window.matchMedia('(max-width: 767px)').matches);

                // 窄屏下标题左对齐、图例下移一行，避免标题与图例在窄画布上互相覆盖
                const buildChartLegend = (top = 20) => isCompact.value
                    ? { top, left: 0, itemWidth: 12, itemHeight: 8, itemGap: 8, textStyle: { fontSize: 10, color: CHART.label } }
                    : { top: 0, right: 0, itemWidth: 12, itemHeight: 8, textStyle: { fontSize: 10, color: CHART.label } };

                const chartTitle = (text, extra = {}) => isCompact.value
                    ? { text, left: 0, top: 0, textStyle: { fontSize: 12 }, ...extra }
                    : { text, textStyle: { fontSize: 13 }, ...extra };

                const updateCharts = () => {
                    if (!gasChart) return;

                    // 时间尺度只决定“显示哪些周期”，不改变统计口径：
                    // 综合费用 / 能耗 = 自购车起累计支出 ÷ 自购车起累计总里程（终身平均）
                    const windowStart = getWindowStart();

                    // 聚合遍历全历史记录；分母为绝对总里程 stat.maxTotal，不做基线扣减
                    const ascAllRecords = [...activeRecords.value].sort((a, b) => new Date(a.date) - new Date(b.date));
                    // 时间窗只把窗前的周期挡在图表外，它们仍参与累计与差分
                    const windowKey = windowStart ? getPeriodKey(fmtDate(windowStart)) : null;

                    let gasDates = [], gasValues = [], gasTotalValues = [], gasForecastValues = [], gasMeta = [];
                    let gasAnomalyCount = 0;
                    let gasWindowHev = 0, gasWindowEv = 0, gasWindowTotal = 0;
                    // 记录每个点的 CS 是否为实测值：补全只参照实测点，避免估算值互相传染
                    let gasCsMeasured = [];
                    let gasCsFilledCount = 0;
                    let evDates = [], evValues = [];
                    let costDates = [], costValues = [];
                    let energyDates = [], energyValues = [];
                    let mileageDates = [], totalMileageValues = [];
                    let hevValues = [], evValuesMileage = [];
                    let ratioDates = [], ratioValues = [];

                    const fuelMultiplier = appSettings.fuelUnit === 'L/百公里' ? 100 : 1;
                    const fuelDigits = appSettings.fuelUnit === 'L/百公里' ? 2 : 4;
                    const costMultiplier = appSettings.costUnit === '元/百公里' ? 100 : 1;
                    const csMode = appSettings.csMode === 'manual' ? 'manual' : 'auto';
                    const csDutyRaw = Number(appSettings.csDuty);
                    const csDuty = Number.isFinite(csDutyRaw)
                        ? Math.min(0.60, Math.max(0.05, csDutyRaw))
                        : 0.18;

                    // 统一按周期（月 / 季度 / 半年 / 年）聚合展示走势图
                    {
                        // 【统一按周期聚合：遍历全历史记录，累计不随窗口重置】
                        let periodData = {};
                        let periods = [];
                        
                        ascAllRecords.forEach(r => {
                            const p = getPeriodKey(r.date);
                            if (!periodData[p]) {
                                periodData[p] = { 
                                    liters: 0, chargeAmt: 0, totalCost: 0, energyCost: 0,
                                    fuelCount: 0, negativeLiters: false, fuelAmountOnly: false,
                                    maxHev: -1, maxEv: -1, maxTotal: -1,
                                    minHev: -1, minEv: -1, minTotal: -1
                                };
                                periods.push(p);
                            }
                            
                            const stat = periodData[p];
                            const isMileageValid = requiresMileage(r.categoryName);
                            const validMileage = !isMileageValid ? 0 : getMileage(r);
                            // 聚合前显式数值化，杜绝字符串金额被累加为拼接结果
                            const amount = Number(r.amount) || 0;
                            const liters = Number(r.liters) || 0;
                            const hev = Number(r.hev) || 0;
                            const ev = Number(r.ev) || 0;
                            
                            stat.liters += (r.categoryName === '加油' ? liters : 0);
                            if (r.categoryName === '加油') {
                                stat.fuelCount += 1;
                                if (liters < 0) stat.negativeLiters = true;
                                if (liters <= 0 && amount > 0) stat.fuelAmountOnly = true;
                            }
                            stat.chargeAmt += (r.categoryName === '充电' ? (r.recordType === 'income' ? 0 : amount) : 0);
                            
                            stat.totalCost += (r.recordType === 'income' ? -amount : amount);
                            if (r.categoryName === '加油' || r.categoryName === '充电') {
                                stat.energyCost += (r.recordType === 'income' ? 0 : amount);
                            }

                            if (validMileage > 0) {
                                if (stat.maxTotal === -1 || validMileage > stat.maxTotal) stat.maxTotal = validMileage;
                                if (stat.minTotal === -1 || validMileage < stat.minTotal) stat.minTotal = validMileage;
                            }
                            if (hev > 0 && isMileageValid) {
                                if (stat.maxHev === -1 || hev > stat.maxHev) stat.maxHev = hev;
                                if (stat.minHev === -1 || hev < stat.minHev) stat.minHev = hev;
                            }
                            if (ev > 0 && isMileageValid) {
                                if (stat.maxEv === -1 || ev > stat.maxEv) stat.maxEv = ev;
                                if (stat.minEv === -1 || ev < stat.minEv) stat.minEv = ev;
                            }
                        });

                        periods = [...new Set(periods)].sort();
                        
                        let prevMaxHev = -1, prevMaxEv = -1, prevMaxTotal = -1;
                        let cumulativeTotalCost = 0, cumulativeEnergyCost = 0;

                        periods.forEach((p, index) => {
                            const stat = periodData[p];
                            cumulativeTotalCost += stat.totalCost;
                            cumulativeEnergyCost += stat.energyCost;

                            let hevDiff = 0, evDiff = 0, totalDiff = 0;
                            
                            if (index === 0) {
                                if (stat.maxHev > -1 && stat.minHev > -1) hevDiff = stat.maxHev - stat.minHev;
                                if (stat.maxEv > -1 && stat.minEv > -1) evDiff = stat.maxEv - stat.minEv;
                                if (stat.maxTotal > -1 && stat.minTotal > -1) totalDiff = stat.maxTotal - stat.minTotal;
                            } else {
                                if (stat.maxHev > -1) hevDiff = stat.maxHev - (prevMaxHev > -1 ? prevMaxHev : stat.minHev);
                                if (stat.maxEv > -1) evDiff = stat.maxEv - (prevMaxEv > -1 ? prevMaxEv : stat.minEv);
                                if (stat.maxTotal > -1) totalDiff = stat.maxTotal - (prevMaxTotal > -1 ? prevMaxTotal : stat.minTotal);
                            }

                            // 时间窗之前的周期只参与累计与差分，不进入图表；
                            // 窗口首周期因此能拿到上一个周期的里程基准，油耗/充电成本点不再缺失
                            const inWindow = !windowKey || p >= windowKey;

                            if (inWindow && hevDiff + evDiff > 0) {
                                ratioDates.push(p);
                                ratioValues.push(((evDiff / (hevDiff + evDiff)) * 100).toFixed(1));
                            }

                            // 当前时间窗内的实际 CS 里程占比（HEV 里程 ÷ 总里程）
                            if (inWindow) {
                                if (totalDiff > 0) {
                                    gasWindowTotal += totalDiff;
                                    gasWindowHev += Math.max(0, hevDiff);
                                } else {
                                    gasWindowHev += Math.max(0, hevDiff);
                                    gasWindowEv += Math.max(0, evDiff);
                                }
                                if (stat.fuelAmountOnly && stat.liters <= 0) gasAnomalyCount += 1;
                            }

                            if (inWindow && stat.liters > 0) {
                                const totalValid = totalDiff > 0;
                                const hevValid = hevDiff > 0;
                                const csValid = hevValid && !(totalValid && hevDiff > totalDiff);
                                const metaHev = Math.max(0, hevDiff);
                                const metaEv = Math.max(0, evDiff);
                                const fuelQuality = [];

                                if (totalDiff < 0 || hevDiff < 0 || evDiff < 0) fuelQuality.push('mileageReset');
                                if (!totalValid) fuelQuality.push('noTotalMileage');
                                if (!hevValid) fuelQuality.push('noHevMileage');
                                if (totalValid && hevValid && hevDiff > totalDiff) fuelQuality.push('hevExceedsTotal');
                                if (stat.fuelCount >= 2) fuelQuality.push('multiRefuel');
                                if (stat.negativeLiters) fuelQuality.push('negativeLiters');

                                if (!totalValid && !csValid) {
                                    gasAnomalyCount += 1;
                                } else {
                                    const csFuel = csValid ? (stat.liters / hevDiff) * fuelMultiplier : null;
                                    const etaActual = totalValid
                                        ? metaHev / totalDiff
                                        : ((metaHev + metaEv) > 0 ? metaHev / (metaHev + metaEv) : null);

                                    gasDates.push(p);
                                    gasTotalValues.push(totalValid ? Number(((stat.liters / totalDiff) * fuelMultiplier).toFixed(fuelDigits)) : null);
                                    gasValues.push(csValid ? Number(csFuel.toFixed(fuelDigits)) : null);
                                    gasCsMeasured.push(csValid);
                                    gasForecastValues.push(csMode === 'manual' && csFuel !== null
                                        ? Number((csFuel * csDuty).toFixed(fuelDigits))
                                        : null);
                                    gasMeta.push({
                                        liters: stat.liters,
                                        totalDiff: totalValid ? totalDiff : 0,
                                        hevDiff: metaHev,
                                        evDiff: metaEv,
                                        etaActual,
                                        quality: fuelQuality
                                    });
                                }
                            }
                            if (inWindow && evDiff > 0 && stat.chargeAmt > 0) {
                                evDates.push(p);
                                evValues.push(((stat.chargeAmt / evDiff) * costMultiplier).toFixed(2));
                            }
                            // 分母为绝对总里程 stat.maxTotal，自购车起累计支出 ÷ 自购车起累计总里程
                            if (inWindow && stat.maxTotal > 0) {
                                costDates.push(p);
                                costValues.push(((cumulativeTotalCost / stat.maxTotal) * costMultiplier).toFixed(2));
                                energyDates.push(p);
                                energyValues.push(((cumulativeEnergyCost / stat.maxTotal) * costMultiplier).toFixed(2));
                                
                                mileageDates.push(p);
                                totalMileageValues.push(stat.maxTotal);
                                hevValues.push(stat.maxHev);
                                evValuesMileage.push(stat.maxEv);
                            }

                            if (stat.maxHev > -1) prevMaxHev = stat.maxHev;
                            if (stat.maxEv > -1) prevMaxEv = stat.maxEv;
                            if (stat.maxTotal > -1) prevMaxTotal = stat.maxTotal;
                        });

                        const etaBase = gasWindowTotal > 0 ? gasWindowTotal : (gasWindowHev + gasWindowEv);
                        gasActualEta.value = etaBase > 0 ? (gasWindowHev / etaBase) * 100 : null;

                        // ===== CS 曲线自动补全 =====
                        // 断续根因：周期内 HEV 里程增量为 0（纯电出行月 / HEV 里程未更新）时，
                        // CS 分母为 0，原逻辑把该点置为 null，ECharts 在 null 处断线。
                        // 补全规则：仅对“有加油、有总里程增量、HEV 增量为 0、非里程回退”的周期，
                        // 用最近实测周期的实际 η 反推 HEV 里程（η 优先就近，其次使用时间窗 η），
                        // 再按该周期实测加油量计算 CS；无可用 η 参照时保持 null。
                        // 补全点以空心圆标注并在 Tooltip 说明来源，不参与 η、加油量与异常计数统计。
                        const csValueOf = (v) => {
                            const raw = (v && typeof v === 'object') ? v.value : v;
                            return (raw === null || raw === undefined || raw === '') ? null : Number(raw);
                        };
                        const nearestMeasuredEta = (index) => {
                            for (let step = 1; step <= gasValues.length; step += 1) {
                                const prevIndex = index - step;
                                if (prevIndex >= 0 && gasCsMeasured[prevIndex]) {
                                    const eta = gasMeta[prevIndex] && gasMeta[prevIndex].etaActual;
                                    if (eta > 0) return eta;
                                }
                                const nextIndex = index + step;
                                if (nextIndex < gasValues.length && gasCsMeasured[nextIndex]) {
                                    const eta = gasMeta[nextIndex] && gasMeta[nextIndex].etaActual;
                                    if (eta > 0) return eta;
                                }
                            }
                            return null;
                        };
                        const windowEta = gasActualEta.value === null ? null : gasActualEta.value / 100;
                        for (let i = 0; i < gasValues.length; i += 1) {
                            if (gasCsMeasured[i]) continue;
                            const meta = gasMeta[i];
                            if (!meta || !(meta.liters > 0) || !(meta.totalDiff > 0)) continue;
                            if (meta.hevDiff > 0) continue;
                            if (meta.quality.includes('mileageReset')) continue;
                            const refEta = nearestMeasuredEta(i) ?? windowEta;
                            if (!(refEta > 0)) continue;
                            const hevEst = meta.totalDiff * refEta;
                            const csEst = hevEst > 0 ? (meta.liters / hevEst) * fuelMultiplier : null;
                            if (csEst === null || !Number.isFinite(csEst) || csEst <= 0) continue;
                            const rounded = Number(csEst.toFixed(fuelDigits));
                            gasValues[i] = {
                                value: rounded,
                                symbol: 'emptyCircle',
                                symbolSize: isCompact.value ? 5 : 6,
                                itemStyle: { color: '#fff', borderColor: CHART.blue, borderWidth: 1.5 }
                            };
                            if (csMode === 'manual') {
                                gasForecastValues[i] = Number((rounded * csDuty).toFixed(fuelDigits));
                            }
                            meta.csFilled = true;
                            meta.csRefEta = refEta;
                            meta.quality.push('csFilled');
                            gasCsFilledCount += 1;
                        }
                    }

                    // 饼图 / 分类走势只展示时间窗内的记录；走势曲线的窗口裁剪已在聚合阶段由 windowKey 完成
                    let rawRecordsForCategory = [...ascAllRecords];
                    if (windowStart) {
                        rawRecordsForCategory = rawRecordsForCategory.filter(r => new Date(r.date) >= windowStart);
                    }

                    // 2. 饼图排版优化：缩小半径，加入文本换行
                    let pieDataMap = {};
                    rawRecordsForCategory.forEach(r => {
                        if (r.recordType !== 'income') {
                            const amount = Number(r.amount) || 0;
                            pieDataMap[r.categoryName] = (pieDataMap[r.categoryName] || 0) + amount;
                        }
                    });
                    let pieData = Object.keys(pieDataMap).map(k => ({ name: k, value: pieDataMap[k].toFixed(2) }));

                    let subCatMap = {};
                    rawRecordsForCategory.forEach(r => {
                        if (r.categoryName === selectedChartCategory.value && r.subCategory && r.recordType !== 'income') {
                            const amount = Number(r.amount) || 0;
                            subCatMap[r.subCategory] = (subCatMap[r.subCategory] || 0) + amount;
                        }
                    });
                    let subCatData = Object.keys(subCatMap).map(k => ({ name: k, value: subCatMap[k].toFixed(2) }));

                    // 3. 准备特定分类走势柱状图数据（跟随当前时间尺度的聚合粒度）
                    let catTrendMap = {};
                    if (rawRecordsForCategory.length > 0) {
                        let firstDate = new Date(rawRecordsForCategory[0].date);
                        let lastDate = new Date(rawRecordsForCategory[rawRecordsForCategory.length - 1].date);
                        if (chartPeriod.value === 'year') {
                            for (let y = firstDate.getFullYear(); y <= lastDate.getFullYear(); y++) {
                                catTrendMap[y + '年'] = 0;
                            }
                        } else if (chartPeriod.value === 'quarter') {
                            let cursor = new Date(firstDate.getFullYear(), Math.floor(firstDate.getMonth() / 3) * 3, 1);
                            const endCursor = new Date(lastDate.getFullYear(), Math.floor(lastDate.getMonth() / 3) * 3, 1);
                            while (cursor <= endCursor) {
                                catTrendMap[cursor.getFullYear() + 'Q' + (Math.floor(cursor.getMonth() / 3) + 1)] = 0;
                                cursor.setMonth(cursor.getMonth() + 3);
                            }
                        } else {
                            let cursor = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);
                            const endCursor = new Date(lastDate.getFullYear(), lastDate.getMonth(), 1);
                            while (cursor <= endCursor) {
                                catTrendMap[cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0')] = 0;
                                cursor.setMonth(cursor.getMonth() + 1);
                            }
                        }
                    }

                    rawRecordsForCategory.forEach(r => {
                        if (r.categoryName === selectedChartCategory.value) {
                            let key = getPeriodKey(r.date);
                            const amount = Number(r.amount) || 0;
                            if (catTrendMap[key] !== undefined) {
                                catTrendMap[key] += amount;
                            } else {
                                catTrendMap[key] = amount;
                            }
                        }
                    });

                    let catTrendDates = Object.keys(catTrendMap).sort((a, b) => a.localeCompare(b));
                    let catTrendValues = catTrendDates.map(k => catTrendMap[k].toFixed(2));

                    // ====== 渲染所有图表 ======
                    const commonOptions = {
                        color: CHART_PIE_COLORS,
                        tooltip: { ...chartTooltipBase, trigger: 'axis' },
                        legend: { ...buildChartLegend() },
                        grid: { left: '15%', right: '8%', bottom: '12%', top: '30%' },
                        xAxis: {
                            type: 'category', boundaryGap: false,
                            axisLine: { lineStyle: { color: CHART.axis } },
                            axisTick: { show: false },
                            axisLabel: { color: CHART.label, fontSize: 10 }
                        }
                    };

                    // 里程总览：合并原“总里程变化”与“HEV与EV里程变化”
                    // 左轴=累计总里程（面积线），右轴=HEV/EV 分项里程，保留两组核心维度
                    mileageChart.setOption({
                        tooltip: { ...chartTooltipBase, trigger: 'axis', axisPointer: { type: 'cross' } },
                        legend: { ...buildChartLegend(), data: ['总里程', 'HEV里程', 'EV里程'] },
                        grid: { left: '12%', right: '12%', bottom: '12%', top: '32%' },
                        title: chartTitle('里程总览 (km)'),
                        xAxis: { ...commonOptions.xAxis, data: mileageDates },
                        yAxis: [
                            { ...chartYAxis, name: '总里程', nameTextStyle: { color: CHART.label, fontSize: 10 }, scale: true },
                            { ...chartYAxis, name: 'HEV/EV', nameTextStyle: { color: CHART.label, fontSize: 10 }, scale: true, splitLine: { show: false } }
                        ],
                        series: [
                            { ...chartPoint, name: '总里程', type: 'line', data: totalMileageValues, smooth: true, color: CHART.blue, areaStyle: { opacity: 0.10 }, yAxisIndex: 0 },
                            { ...chartPoint, name: 'HEV里程', type: 'line', data: hevValues, smooth: true, color: CHART.amber, yAxisIndex: 1 },
                            { ...chartPoint, name: 'EV里程', type: 'line', data: evValuesMileage, smooth: true, color: CHART.green, yAxisIndex: 1 }
                        ]
                    });

                    chartEvRatio.setOption({
                        ...commonOptions,
                        legend: { ...buildChartLegend(), data: ['纯电比例'] },
                        title: chartTitle('纯电比例 (EV Ratio %)'),
                        xAxis: { ...commonOptions.xAxis, data: ratioDates },
                        yAxis: { ...chartYAxis, max: 100 },
                        series: [{ ...chartPoint, name: '纯电比例', type: 'line', data: ratioValues, smooth: true, color: CHART.green, areaStyle: { opacity: 0.18 } }]
                    });

                    // ===== 油耗分析图表：口径与双轴（GB/T 19753 对标）=====
                    const fuelUnitText = appSettings.fuelUnit;
                    const wltcCombined = appSettings.fuelUnit === 'L/百公里' ? 1.98 : 0.0198;
                    const wltcCs = appSettings.fuelUnit === 'L/百公里' ? 5.3 : 0.053;
                    const wltcDigits = appSettings.fuelUnit === 'L/百公里' ? 2 : 4;
                    const wltcText = (v) => {
                        const text = v.toFixed(wltcDigits);
                        return text.indexOf('.') >= 0 ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
                    };
                    const gasAxisMaxWith = (base, ratio) => (value) => {
                        const rawMax = Number(value && value.max);
                        return Math.max(Number.isFinite(rawMax) ? rawMax : 0, base) * ratio;
                    };
                    const gasQualityText = {
                        mileageReset: '里程回退或重置',
                        noTotalMileage: '总里程缺失',
                        noHevMileage: 'HEV里程缺失',
                        hevExceedsTotal: 'HEV里程大于总里程',
                        multiRefuel: '周期内多次加油',
                        negativeLiters: '存在负加油量',
                        csFilled: 'CS补全（按邻近η估算）'
                    };
                    const gasEtaText = gasActualEta.value === null ? '—' : `${gasActualEta.value.toFixed(1)}%`;
                    const gasEtaMismatch = csMode === 'manual'
                        && gasActualEta.value !== null
                        && Math.abs(csDuty * 100 - gasActualEta.value) > 20;
                    const gasSubtext = [
                        csMode === 'manual' ? `η=${csDuty.toFixed(2)}（手动）` : `η=${gasEtaText}（自动）`,
                        `WLTC ${wltcText(wltcCombined)}/${wltcText(wltcCs)}`
                    ].join(' · ')
                        + (gasEtaMismatch ? ' · η偏差大' : '')
                        + (gasCsFilledCount > 0 ? ` · 补全 ${gasCsFilledCount}` : '')
                        + (gasAnomalyCount > 0 ? ` · 异常 ${gasAnomalyCount}` : '');

                    const gasSeries = [
                        {
                            ...chartPoint,
                            name: '综合油耗（实际）',
                            type: 'line',
                            data: gasTotalValues,
                            smooth: true,
                            color: CHART.amber,
                            lineStyle: { width: 2 },
                            ...(gasTotalValues.some(v => v !== null) ? {
                                markLine: {
                                    silent: true,
                                    symbol: 'none',
                                    data: [{
                                        yAxis: wltcCombined,
                                        label: { formatter: `WLTC综合 ${wltcText(wltcCombined)}`, fontSize: 9, color: CHART.label },
                                        lineStyle: { color: CHART.slate, type: 'dotted' }
                                    }]
                                }
                            } : {})
                        },
                        {
                            ...chartPoint,
                            name: 'CS油耗（实测代理）',
                            type: 'line',
                            data: gasValues,
                            smooth: true,
                            color: CHART.blue,
                            yAxisIndex: 1,
                            connectNulls: true,
                            lineStyle: { width: 2 },
                            ...(gasValues.some(v => v !== null) ? {
                                markLine: {
                                    silent: true,
                                    symbol: 'none',
                                    data: [{
                                        yAxis: wltcCs,
                                        label: { formatter: `WLTC馈电 ${wltcText(wltcCs)}`, fontSize: 9, color: CHART.label },
                                        lineStyle: { color: CHART.slate, type: 'dotted' }
                                    }]
                                }
                            } : {})
                        }
                    ];
                    if (csMode === 'manual') {
                        gasSeries.push({
                            ...chartPoint,
                            name: '综合油耗预测',
                            type: 'line',
                            data: gasForecastValues,
                            smooth: true,
                            color: CHART.violet,
                            connectNulls: true,
                            lineStyle: { type: 'dashed', width: 1.5 }
                        });
                    }

                    gasChart.setOption({
                        tooltip: {
                            ...chartTooltipBase,
                            trigger: 'axis',
                            extraCssText: (chartTooltipBase.extraCssText || '') + 'max-width:280px;white-space:normal;',
                            formatter: (params) => {
                                if (!params || !params.length) return '';
                                const idx = params[0].dataIndex;
                                const meta = gasMeta[idx];
                                if (!meta) return '';
                                const fmtFuel = (v) => {
                                    const raw = (v && typeof v === 'object') ? v.value : v;
                                    return (raw === null || raw === undefined || raw === '') ? '—' : `${Number(raw).toFixed(fuelDigits)} ${fuelUnitText}`;
                                };
                                const fmtKm = (v) => Number(v) > 0 ? `${Math.round(Number(v)).toLocaleString('zh-CN')} km` : '—';
                                const fmtEta = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : `${(Number(v) * 100).toFixed(1)}%`;
                                const qualityLabels = meta.quality.map(k => gasQualityText[k]).filter(Boolean);
                                const rows = [
                                    `<div style="font-weight:600;margin-bottom:4px;">${gasDates[idx] || params[0].axisValue}</div>`,
                                    `<div>综合油耗（实际）：${fmtFuel(gasTotalValues[idx])}</div>`,
                                    `<div>CS油耗（实测代理）：${fmtFuel(gasValues[idx])}${meta.csFilled ? '（估算）' : ''}</div>`                                ];
                                if (csMode === 'manual') {
                                    rows.push(`<div>综合油耗预测（η=${csDuty.toFixed(2)}）：${fmtFuel(gasForecastValues[idx])}</div>`);
                                }
                                rows.push(`<div style="margin-top:4px;border-top:1px solid #E5E7EB;padding-top:4px;">加油量：${Number(meta.liters) > 0 ? Number(meta.liters).toFixed(2) + ' L' : '—'}</div>`);
                                rows.push(`<div>总里程：${fmtKm(meta.totalDiff)}｜HEV：${fmtKm(meta.hevDiff)}｜EV：${fmtKm(meta.evDiff)}</div>`);
                                rows.push(`<div>实际CS里程占比 η：${fmtEta(meta.etaActual)}</div>`);
                                if (meta.csFilled) {
                                    rows.push(`<div>补全依据：邻近周期 η ${fmtEta(meta.csRefEta)}</div>`);
                                }
                                rows.push(`<div>数据质量：${qualityLabels.length ? qualityLabels.join(' / ') : '正常'}</div>`);
                                return rows.join('');
                            }
                        },
                        legend: { ...buildChartLegend(34), data: gasSeries.map(s => s.name) },
                        grid: { left: '15%', right: '14%', bottom: '12%', top: '34%' },
                        title: chartTitle(`油耗分析 (${appSettings.fuelUnit})`, {
                            subtext: gasSubtext,
                            subtextStyle: { fontSize: 10, color: CHART.label }
                        }),
                        graphic: gasDates.length ? [] : [{
                            type: 'text',
                            left: 'center',
                            top: 'middle',
                            silent: true,
                            style: { text: '当前时间范围无有效加油记录', fill: CHART.label, fontSize: 12 }
                        }],
                        xAxis: { ...commonOptions.xAxis, data: gasDates },
                        yAxis: [
                            { ...chartYAxis, name: '综合', nameTextStyle: { color: CHART.label, fontSize: 10 }, min: 0, max: gasAxisMaxWith(wltcCombined, 1.15) },
                            { ...chartYAxis, name: 'CS/段', nameTextStyle: { color: CHART.label, fontSize: 10 }, min: 0, max: gasAxisMaxWith(wltcCs, 1.10), splitLine: { show: false } }
                        ],
                        series: gasSeries
                    }, { notMerge: true });

                    evChart.setOption({
                        ...commonOptions,
                        legend: { ...buildChartLegend(), data: ['充电成本'] },
                        title: chartTitle(`区间充电成本 (${appSettings.costUnit})`),
                        xAxis: { ...commonOptions.xAxis, data: evDates },
                        yAxis: { ...chartYAxis, min: 'dataMin' },
                        series: [{ ...chartPoint, name: '充电成本', type: 'line', data: evValues, smooth: true, color: CHART.green }]
                    });

                    totalEnergyChart.setOption({
                        ...commonOptions,
                        legend: { ...buildChartLegend(), data: ['综合能耗'] },
                        title: chartTitle(`综合能耗曲线 (${appSettings.costUnit})`),
                        xAxis: { ...commonOptions.xAxis, data: energyDates },
                        yAxis: { ...chartYAxis, min: 'dataMin' },
                        series: [{ ...chartPoint, name: '综合能耗', type: 'line', data: energyValues, smooth: true, color: CHART.blue, areaStyle: { opacity: 0.12 } }]
                    });

                    costChart.setOption({
                        ...commonOptions,
                        legend: { ...buildChartLegend(), data: ['综合净费用'] },
                        title: chartTitle(`综合净费用走势 (${appSettings.costUnit})`),
                        xAxis: { ...commonOptions.xAxis, data: costDates },
                        yAxis: { ...chartYAxis },
                        series: [{ ...chartPoint, name: '综合净费用', type: 'line', data: costValues, smooth: true, color: CHART.blue, areaStyle: { opacity: 0.12 } }]
                    });

                    chartCategoryPie.setOption({
                        color: CHART_PIE_COLORS,
                        title: { text: '分类支出占比', textStyle: { fontSize: 13 }, left: 'center' },
                        tooltip: { ...chartTooltipBase, trigger: 'item', formatter: '{b}: {c}元 ({d}%)' },
                        series: [{
                            type: 'pie', radius: ['25%', '50%'], center: ['50%', '55%'],
                            itemStyle: { borderRadius: 5, borderColor: '#fff', borderWidth: 2 },
                            label: { formatter: '{b}\n{c}元\n({d}%)', lineHeight: 14, color: '#374151', fontSize: 10 },
                            data: pieData, emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(15, 23, 42, 0.15)' } }
                        }]
                    });

                    if (showSubCatPie.value) {
                        if (!chartSubCategoryPie) chartSubCategoryPie = echarts.init(document.getElementById('chartSubCategoryPie'));
                        chartSubCategoryPie.setOption({
                            color: CHART_PIE_COLORS,
                            title: { text: `【${selectedChartCategory.value}】子项目占比`, textStyle: { fontSize: 13 }, left: 'center' },
                            tooltip: { ...chartTooltipBase, trigger: 'item', formatter: '{b}: {c}元 ({d}%)' },
                            series: [{
                                type: 'pie', radius: '50%', center: ['50%', '55%'],
                                itemStyle: { borderRadius: 3, borderColor: '#fff', borderWidth: 2 },
                                label: { formatter: '{b}\n{c}元\n({d}%)', lineHeight: 14, color: '#374151', fontSize: 10 },
                                data: subCatData, emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(15, 23, 42, 0.15)' } }
                            }]
                        });
                    }

                    const curCatObj = categories.value.find(c => c.name === selectedChartCategory.value);
                    const barColor = (curCatObj && curCatObj.type === 'income') ? CHART.green : CHART.blue;

                    chartCategoryTrend.setOption({
                        color: [barColor],
                        title: chartTitle(`【${selectedChartCategory.value || '-'}】金额走势`),
                        tooltip: { ...chartTooltipBase, trigger: 'axis', axisPointer: { type: 'shadow' } },
                        legend: { ...buildChartLegend(), data: ['金额(元)'] },
                        grid: { left: '15%', right: '8%', bottom: '14%', top: '30%' },
                        xAxis: {
                            type: 'category', data: catTrendDates,
                            axisLine: { lineStyle: { color: CHART.axis } },
                            axisTick: { show: false },
                            axisLabel: { interval: 'auto', rotate: 30, color: CHART.label, fontSize: 10 }
                        },
                        yAxis: { ...chartYAxis, name: '元', nameTextStyle: { color: CHART.label, fontSize: 10 } },
                        series: [{
                            name: '金额(元)', type: 'bar', data: catTrendValues,
                            barMaxWidth: 32,
                            itemStyle: { borderRadius: [4, 4, 0, 0] },
                            label: { show: catTrendValues.length <= 12, position: 'top', fontSize: 9, color: CHART.label }
                        }]
                    });

                    nextTick(() => {
                        if (chartCategoryTrend) chartCategoryTrend.resize();
                        if (showSubCatPie.value && chartSubCategoryPie) chartSubCategoryPie.resize();
                    });
                };

                const handleTabClick = (tab) => {
                    if (tab.paneName === 'home') {
                        nextTick(() => { updateCharts(); });
                    }
                };

                const exportData = (silent) => {
                    const data = { vehicles: vehicles.value, categories: categories.value, records: records.value, settings: appSettings };
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `混动车全生命周期记录备份_${new Date().toISOString().slice(0,10)}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    if (silent !== true) ElementPlus.ElMessage.success('备份文件已导出');
                };

                const exportCSV = () => {
                    let csvContent = "\uFEFF"; 
                    csvContent += "车辆名称,日期,收支类型,一级类别,具体项目,金额(元),总里程(km),HEV里程(km),EV里程(km),升数(L),电量(kWh),备注\n";
                    
                    const vMap = {};
                    vehicles.value.forEach(v => vMap[v.id] = v.name);

                    records.value.forEach(r => {
                        const vName = vMap[r.vehicleId] || '未知车辆';
                        const rType = r.recordType === 'income' ? '收入' : '支出';
                        const subCat = r.subCategory || '';
                        const totalM = r.totalMileage || (r.hev + r.ev) || '';
                        const hev = r.hev || '';
                        const ev = r.ev || '';
                        const liters = r.liters || '';
                        const kwh = r.kwh || '';
                        const remark = r.remark || '';
                        
                        csvContent += `"${vName}","${r.date}","${rType}","${r.categoryName}","${subCat}",${r.amount},${totalM},${hev},${ev},${liters},${kwh},"${remark}"\n`;
                    });

                    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `混动车全生命周期数据导出_${new Date().toISOString().slice(0,10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    ElementPlus.ElMessage.success('CSV 表格已导出');
                };

                // 数据备份状态：本地保存时间取最近一次写入，服务端备份份数由 /api/status 提供
                const backupInfo = ref({ available: false, count: 0, latestAt: null, keep: 30 });
                const lastSyncAt = ref(window.__hevLastSavedAt || null);
                const lastSavedText = computed(() => lastSavedAt.value ? formatLogTime(lastSavedAt.value) : '暂无记录');
                const lastSyncText = computed(() => lastSyncAt.value ? formatLogTime(lastSyncAt.value) : '等待服务端同步');
                const backupCountText = computed(() => {
                    if (!backupInfo.value.available) return '未连接服务端';
                    const latest = backupInfo.value.latestAt ? formatLogTime(backupInfo.value.latestAt) : '暂无';
                    return `${backupInfo.value.count} 份（上限 ${backupInfo.value.keep} 份），最近 ${latest}`;
                });

                const refreshBackupInfo = async () => {
                    lastSyncAt.value = window.__hevLastSavedAt || lastSyncAt.value;
                    try {
                        const res = await fetch('/api/status', { credentials: 'same-origin' });
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        const data = await res.json();
                        const backup = data && data.backup ? data.backup : {};
                        backupInfo.value = {
                            available: true,
                            count: Number(backup.count) || 0,
                            latestAt: backup.latestAt || null,
                            keep: Number(backup.keep) || 30
                        };
                    } catch (e) {
                        backupInfo.value = Object.assign({}, backupInfo.value, { available: false });
                    }
                };

                watch(activeTab, (tab) => { if (tab === 'settings') refreshBackupInfo(); });

                const triggerFileInput = () => { document.getElementById('fileInput').click(); };

                const importData = (event) => {
                    if (!requireManage()) return;
                    const file = event.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        let data;
                        try {
                            data = JSON.parse(e.target.result);
                        } catch (err) {
                            ElementPlus.ElMessage.error('导入失败：不是有效的备份文件');
                            return;
                        }
                        if (!data || !Array.isArray(data.categories) || !Array.isArray(data.records)) {
                            ElementPlus.ElMessage.error('导入失败：不是有效的备份文件');
                            return;
                        }
                        const incomingVehicles = Array.isArray(data.vehicles) ? data.vehicles.length : 0;
                        const summary = [
                            `当前数据：车辆 ${vehicles.value.length} 辆、类别 ${categories.value.length} 个、记录 ${records.value.length} 条`,
                            `待导入：车辆 ${incomingVehicles} 辆、类别 ${data.categories.length} 个、记录 ${data.records.length} 条`
                        ].join('<br>');
                        const message = `<div style="line-height:1.8;">导入会覆盖当前全部数据且无法自动回滚。<br>${summary}<br>确认后将先自动导出当前数据备份，再执行导入。</div>`;
                        ElementPlus.ElMessageBox.confirm(message, '确认恢复数据', {
                            type: 'warning',
                            confirmButtonText: '覆盖并导入',
                            cancelButtonText: '取消',
                            dangerouslyUseHTMLString: true
                        }).then(() => {
                            try {
                                // 导入前自动导出一份当前数据，降低误操作风险
                                exportData(true);
                                // 先完成数据转换再整体替换，避免转换异常导致数据被部分覆盖
                                const nextVehicles = incomingVehicles > 0
                                    ? data.vehicles
                                    : JSON.parse(JSON.stringify(defaultVehicles));
                                const nextRecords = normalizeRecords(data.records);
                                vehicles.value = nextVehicles;
                                categories.value = data.categories;
                                records.value = nextRecords;
                                if (data.settings) Object.assign(appSettings, data.settings);
                                appSettings.csMode = appSettings.csMode === 'manual' ? 'manual' : 'auto';
                                const importedCsDuty = Number(appSettings.csDuty);
                                appSettings.csDuty = Number.isFinite(importedCsDuty)
                                    ? Math.min(0.60, Math.max(0.05, importedCsDuty))
                                    : 0.18;
                                currentVehicleId.value = vehicles.value[0].id;
                                normalizeSubItems();
                                migrateLegacyLabels();
                                sortCategories();
                                saveData();
                                saveSettings();
                                roleBeforeChange.value = appSettings.role || 'admin';
                                ElementPlus.ElMessage.success('数据恢复成功，导入前的数据已自动导出备份');
                                updateCharts();
                            } catch (err) {
                                ElementPlus.ElMessage.error('导入失败：' + (err && err.message ? err.message : '数据格式不匹配'));
                            }
                        }).catch(() => {});
                    };
                    reader.readAsText(file);
                    event.target.value = ''; 
                };

                onMounted(() => {
                    validateTimeScaleBoundaries();
                    loadData();
                    applyDefaultCategory();
                    nextTick(() => {
                        initCharts();
                        // 拖拽排序使用原生事件委托，绑定在表格容器上避免行重渲染后失效
                        const wrap = recordsTableWrap.value;
                        if (wrap) {
                            wrap.addEventListener('dragover', handleTableDragOver);
                            wrap.addEventListener('dragleave', handleTableDragLeave);
                            wrap.addEventListener('drop', handleTableDrop);
                        }
                    });
                    
                    window.addEventListener('resize', () => {
                        // 横竖屏切换或窗口跨断点时，重新生成图表标题/图例排布
                        const compact = window.matchMedia('(max-width: 767px)').matches;
                        if (compact !== isCompact.value) {
                            isCompact.value = compact;
                            updateCharts();
                        }
                        if(gasChart) gasChart.resize();
                        if(evChart) evChart.resize();
                        if(totalEnergyChart) totalEnergyChart.resize();
                        if(costChart) costChart.resize();
                        if(mileageChart) mileageChart.resize();
                        if(chartEvRatio) chartEvRatio.resize();
                        if(chartCategoryPie) chartCategoryPie.resize();
                        if(chartSubCategoryPie && showSubCatPie.value) chartSubCategoryPie.resize();
                        if(chartCategoryTrend) chartCategoryTrend.resize();
                    });
                });

                return {
                    appVersion: APP_VERSION,
                    activeTab, chartPeriod, selectedChartCategory, appSettings, isCompact, gasActualEta,
                    vehicles, currentVehicleId, currentVehicleName, handleVehicleChange, addVehicle, editVehicle, deleteVehicle, vehicleRecordCount,
                    categories, records, activeRecords, form, currentCategory, groupedRecords, hasMileageInfo,
                    filteredCategories, activeCategories, currentPage, pageSize, requiresMileage, showSubCatPie, formatSoc,
                    tableFilter, filteredTableRecords, tableStats, maintenanceInfo, insuranceInfo, inspectionInfo,
                    recordSortMode, handleRecordSortModeChange,
                    handleRecordTypeChange, handleCategoryChange, saveRecord, deleteRecord,
                    handleSocInput, validateSoc, selectDefaultNumberOnFocus,
                    recordsTableWrap, recordRowClassName, onDragStart, onDragEnd,
                    editVisible, editSaving, editForm, editCategories, editTargetCategory, editActiveSubItems,
                    openEditRecord, saveEditRecord, handleEditRecordTypeChange, handleEditCategoryChange,
                    handleEditSocInput, validateEditSoc,
                    saveCategories, addCategory, editCategory, deleteCategory, addSubItem, removeSubItem,
                    enableCategory, deleteCategoryDialogVisible, pendingDeleteCategory, deleteCategoryAffected,
                    deleteCategoryMode, deleteCategoryTargetId, deleteCategoryTargets, confirmDeleteCategory,
                    renameSubItem, renameSnapshot, undoLastRename, saveSettings, handleRoleChange,
                    lastSavedText, lastSyncText, backupInfo, backupCountText, refreshBackupInfo,
                    canEdit, canManage, currentRole, opLogs, logLimit: LOG_LIMIT, loadOpLogs, logActionLabel, formatLogTime,
                    logFilter, logPage, logPageSize, logActionOptions, logCategoryOptions, filteredOpLogs, paginatedOpLogs,
                    resetLogPage, clearLogFilter, exportOpLogs,
                    tagOpsVisible, tagOps, subCategories, tagOpsTags, tagOpsTargets, tagOpsAffected,
                    openTagOpsDialog, onTagOpsCategoryChange, runTagOps, onTagClick,
                    sortDialogVisible, sortDraft, openCategorySort, moveCategory, saveCategoryOrder, resetCategoryOrder,
                    exportData, exportCSV, triggerFileInput, importData, handleTabClick, updateCharts
                };
            }
        });

        app.use(ElementPlus);
        app.mount('#app');
