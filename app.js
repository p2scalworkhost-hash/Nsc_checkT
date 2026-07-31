const rows = [];
const RULES_KEY = "nsc-ot-department-rules";
const CASE_SETTING_KEY = "nsc-ot-last-case-setting";
const LIFF_HISTORY_KEY = "nsc-liff-attendance-history";
const LATE_RULE_KEY = "nsc-late-rule";
const USER_OVERRIDES_KEY = "nsc-user-department-overrides";
const OT_RULE_KEY = "nsc-ot-rule";
const SPECIAL_OT_KEY = "nsc-special-ot-assignments";

// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyDYMkvTCHQ0oRuYANj1Axc_z6HrRkbxCnI",
  authDomain: "p2sowen.firebaseapp.com",
  databaseURL: "https://p2sowen-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "p2sowen",
  storageBucket: "p2sowen.firebasestorage.app",
  messagingSenderId: "432340752812",
  appId: "1:432340752812:web:4cd4a2fc8182a111680209",
  measurementId: "G-KD8M18YTFW"
};

let db = null;
let rulesCache = null;
let lateRuleCache = null;
let otRuleCache = null;
let lastCasesCache = {};
let liffHistoryCache = [];
let userOverridesCache = {};
let profilesCache = [];
let specialOtAssignmentsCache = [];
const specialOtSelectedEmployeeKeys = new Set();

// ── Pagination state ──
const PAGE_SIZE = 25;
let liffCurrentPage = 1;
let caseCurrentPage = 1;

// Initialize Firebase
try {
  if (typeof firebase !== "undefined") {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    console.log("Firebase Firestore initialized successfully.");
  }
} catch (err) {
  console.error("Firebase initialization failed:", err);
}

const defaultRules = [
  {
    department: "OR",
    flatRate: 50,
    bufferHours: 2,
    useNightRate: true,
    nightRate: 80,
  },
  {
    department: "SENIOR MKT",
    flatRate: 100,
    bufferHours: 1,
    useNightRate: false,
    nightRate: 0,
  },
  {
    department: "MKT",
    flatRate: 50,
    bufferHours: 1,
    useNightRate: false,
    nightRate: 0,
  },
  {
    department: "OPERATION",
    flatRate: 50,
    bufferHours: 1,
    useNightRate: false,
    nightRate: 0,
  },
  {
    department: "MAID",
    flatRate: 0,
    bufferHours: 1,
    useNightRate: false,
    nightRate: 0,
  },
  {
    department: "MANAGER",
    flatRate: 0,
    bufferHours: 1,
    useNightRate: false,
    nightRate: 0,
  },
  {
    department: "OTHER",
    flatRate: 50,
    bufferHours: 1,
    useNightRate: false,
    nightRate: 0,
  },
];

// ── Profiles from Firebase ──
async function fetchProfilesFromFirestore() {
  if (db) {
    try {
      const snapshot = await db.collection("profiles").get();
      profilesCache = [];
      snapshot.forEach(function (doc) {
        var data = doc.data();
        if (data.status === "registered" || data.fullName || data.firstName) {
          profilesCache.push({
            id: data.employeeId || doc.id,
            fullName: data.fullName || data.staffDirectoryFullName || (data.firstName + " " + data.lastName),
            nickname: data.nickname || "",
            department: data.department || "",
            position: data.position || data.department || "",
            lineUserId: data.lineUserId || "",
            lineDisplayName: data.lineDisplayName || "",
          });
        }
      });
      console.log("Profiles loaded from Firestore:", profilesCache.length);
      return;
    } catch (err) {
      console.error("Failed to fetch profiles from Firestore:", err);
    }
  }
  profilesCache = [];
}

function getUserKey(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

function loadUserOverrides() {
  return userOverridesCache;
}

async function saveUserOverrides(overrides) {
  userOverridesCache = overrides;
  if (db) {
    try {
      await db.collection("settings").doc("user_overrides").set({ overrides: overrides });
    } catch (err) {
      console.error("saveUserOverrides Firestore failed:", err);
    }
  }
}

function getEffectiveDepartment(row) {
  var key = getUserKey(row.name);
  
  // 1. Check profilesCache first (Firebase source of truth)
  var profile = profilesCache.find(function (p) {
    return getUserKey(p.fullName) === key;
  });
  if (profile && (profile.department || profile.position)) {
    return profile.department || profile.position;
  }

  // 2. Check user overrides
  if (userOverridesCache && userOverridesCache[key]) return userOverridesCache[key];

  // 3. Check LIFF log
  var ll = row.liffLog || findLiffLog(row);
  if (ll && ll.department) return ll.department;

  // 4. Fallback to row department from Excel
  return row.department || "";
}

function getUserLiffStatus(fullName) {
  // LIFF Status = ตรวจจาก profiles ว่ามี lineUserId หรือไม่ (ลงทะเบียนผ่าน LINE แล้ว)
  var profile = profilesCache.find(function (p) {
    return getUserKey(p.fullName) === getUserKey(fullName);
  });
  return profile && profile.lineUserId ? true : false;
}

function renderUsersPage() {
  var body = document.querySelector("#usersBody");
  if (!body) return;

  var overrides = loadUserOverrides();
  var deptOptions = ["OR", "SENIOR MKT", "MKT", "OPERATION", "MAID", "MANAGER", "CS", "SALE", "ADMIN", "HR"];

  if (!profilesCache.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">ยังไม่มีข้อมูลพนักงาน — รอการเชื่อมต่อ Firebase</td></tr>';
    document.querySelector("#totalUsersCount").textContent = "0 คน";
    document.querySelector("#liffLinkedCount").textContent = "0 LIFF";
    return;
  }

  var users = profilesCache.map(function (profile) {
    var key = getUserKey(profile.fullName);
    var effectiveDept = profile.department || profile.position || (overrides && overrides[key]) || "";
    return {
      fullName: profile.fullName,
      nickname: profile.nickname,
      position: effectiveDept,
      currentDepartment: effectiveDept,
      hasLiff: getUserLiffStatus(profile.fullName),
      _profileIndex: profilesCache.indexOf(profile),
    };
  });

  document.querySelector("#totalUsersCount").textContent = users.length + " คน";
  document.querySelector("#liffLinkedCount").textContent = users.filter(function (u) { return u.hasLiff; }).length + " LIFF";

  // Apply name search filtering
  var nameSearchEl = document.querySelector("#usersNameSearch");
  var nameQuery = nameSearchEl ? nameSearchEl.value.trim().toLowerCase() : "";
  var filteredUsers = nameQuery
    ? users.filter(function (u) {
        var full = (u.fullName || "").toLowerCase();
        var nick = (u.nickname || "").toLowerCase();
        return full.includes(nameQuery) || nick.includes(nameQuery);
      })
    : users;

  if (!filteredUsers.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-state">ไม่พบพนักงานที่ตรงกับ "' + escapeHtml(nameQuery) + '"</td></tr>';
    return;
  }

  body.innerHTML = filteredUsers.map(function (user, i) {
    return '<tr class="user-row" data-user-index="' + user._profileIndex + '">' +
      "<td>" + (i + 1) + "</td>" +
      "<td><strong>" + escapeHtml(user.fullName) + "</strong></td>" +
      "<td>" + escapeHtml(user.nickname) + "</td>" +
      "<td>" + escapeHtml(user.position) + "</td>" +
      "<td>" + escapeHtml(user.position) + "</td>" +
      "<td>" + (user.hasLiff ? '<span class="status ok">✓ LIFF Linked</span>' : '<span class="status warn">ยังไม่มี LIFF</span>') + "</td>" +
      "</tr>";
  }).join("");

  // Bind click to open modal (use _profileIndex to map back to profilesCache)
  var rows = document.querySelectorAll(".user-row");
  for (var i = 0; i < rows.length; i++) {
    rows[i].addEventListener("click", function () {
      var idx = Number(this.dataset.userIndex);
      if (idx >= 0 && idx < profilesCache.length) {
        openUserModal(profilesCache[idx], deptOptions);
      }
    });
  }
}

// ── Modal logic ──
function openUserModal(profile, deptOptions) {
  var modal = document.querySelector("#userModal");
  if (!modal) return;

  var overrides = loadUserOverrides();
  var key = getUserKey(profile.fullName);
  var effectiveDept = profile.department || profile.position || (overrides && overrides[key]) || "";

  document.querySelector("#modalUserName").textContent = profile.nickname || profile.fullName;
  document.querySelector("#modalFullName").textContent = profile.fullName;
  document.querySelector("#modalNickname").textContent = profile.nickname || "-";
  document.querySelector("#modalEmployeeId").textContent = profile.id || "-";
  document.querySelector("#modalLineUserId").textContent = profile.lineUserId || "-";

  var deptSelect = document.querySelector("#modalDepartment");
  deptSelect.innerHTML = deptOptions.map(function (d) {
    return '<option value="' + d + '"' + (d === effectiveDept ? " selected" : "") + ">" + d + "</option>";
  }).join("");

  document.querySelector("#modalMessage").textContent = "";
  modal.style.display = "flex";

  function saveHandler() { saveUserModal(profile); }
  function closeHandler() { modal.style.display = "none"; document.querySelector("#saveModalButton").removeEventListener("click", saveHandler); document.querySelector("#cancelModalButton").removeEventListener("click", closeHandler); document.querySelector("#closeModalButton").removeEventListener("click", closeHandler); }

  document.querySelector("#saveModalButton").addEventListener("click", saveHandler);
  document.querySelector("#cancelModalButton").addEventListener("click", closeHandler);
  document.querySelector("#closeModalButton").addEventListener("click", closeHandler);

  // Click outside to close
  modal.addEventListener("click", function clickOutside(e) {
    if (e.target === modal) { closeHandler(); modal.removeEventListener("click", clickOutside); }
  });
}

async function saveUserModal(profile) {
  var dept = document.querySelector("#modalDepartment").value;
  var msg = document.querySelector("#modalMessage");

  // Update Firestore
  if (db && profile.lineUserId) {
    try {
      await db.collection("profiles").doc(profile.lineUserId).update({
        department: dept,
        position: dept,
        updatedAt: new Date().toISOString()
      });
    } catch (err) {
      console.error("Failed to update profile in Firestore:", err);
      if (msg) msg.textContent = "เกิดข้อผิดพลาดในการบันทึก: " + err.message;
      return;
    }
  }

  // Save override to Firestore
  var overrides = loadUserOverrides();
  overrides[getUserKey(profile.fullName)] = dept;
  await saveUserOverrides(overrides);

  // Update cache
  profile.department = dept;
  profile.position = dept;

  if (msg) msg.textContent = "บันทึกแผนก " + dept + " สำหรับ " + profile.fullName + " เรียบร้อย";
  renderUsersPage();

  // Auto close after 1.2s
  setTimeout(function () {
    var modal = document.querySelector("#userModal");
    if (modal) modal.style.display = "none";
  }, 1200);
}

const specialOtReasonLabels = {
  patient_watch: "เฝ้าคนไข้",
  recovery_care: "ดูแลหลังผ่าตัด / รอคนไข้ฟื้น",
  continuous_case: "เคสต่อเนื่องข้ามวัน",
  other: "อื่น ๆ",
};

function loadSpecialOtAssignmentsFromLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(SPECIAL_OT_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function persistSpecialOtAssignmentsLocally() {
  localStorage.setItem(SPECIAL_OT_KEY, JSON.stringify(specialOtAssignmentsCache.slice(0, 500)));
}

function getSelectableSpecialOtEmployees() {
  const employees = new Map();

  profilesCache.forEach((profile) => {
    const fullName = String(profile.fullName || "").trim();
    const key = normalizeName(fullName);
    if (!key) return;
    employees.set(key, {
      key,
      fullName,
      nickname: String(profile.nickname || "").trim(),
      department: String(profile.department || profile.position || "").trim(),
    });
  });

  rows.forEach((row) => {
    const fullName = String(row.name || "").trim();
    const key = normalizeName(fullName);
    if (!key || employees.has(key)) return;
    employees.set(key, {
      key,
      fullName,
      nickname: "",
      department: String(row.department || "").trim(),
    });
  });

  return [...employees.values()].sort((a, b) => a.fullName.localeCompare(b.fullName, "th"));
}

function updateSpecialOtSelectedCount() {
  const count = document.querySelector("#specialOtSelectedCount");
  if (count) count.textContent = `เลือกแล้ว ${specialOtSelectedEmployeeKeys.size} คน`;
}

function getFilteredSelectableSpecialOtEmployees() {
  const query = String(document.querySelector("#specialOtEmployeeSearch")?.value || "").trim().toLowerCase();
  return getSelectableSpecialOtEmployees().filter((employee) => {
    if (!query) return true;
    return `${employee.fullName} ${employee.nickname} ${employee.department}`.toLowerCase().includes(query);
  });
}

function renderSpecialOtEmployeeOptions() {
  const container = document.querySelector("#specialOtEmployeeList");
  if (!container) return;

  const query = String(document.querySelector("#specialOtEmployeeSearch")?.value || "").trim().toLowerCase();
  const employees = getFilteredSelectableSpecialOtEmployees();

  container.replaceChildren();
  if (!employees.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = query ? "ไม่พบพนักงานที่ตรงกับคำค้น" : "ยังไม่มีรายชื่อจาก Firebase หรือไฟล์ Excel";
    container.append(empty);
    updateSpecialOtSelectedCount();
    return;
  }

  employees.forEach((employee) => {
    const label = document.createElement("label");
    label.className = "employee-check-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = employee.key;
    checkbox.checked = specialOtSelectedEmployeeKeys.has(employee.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) specialOtSelectedEmployeeKeys.add(employee.key);
      else specialOtSelectedEmployeeKeys.delete(employee.key);
      updateSpecialOtSelectedCount();
    });

    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = employee.fullName;
    const meta = document.createElement("small");
    meta.textContent = [employee.nickname, employee.department].filter(Boolean).join(" · ") || "ไม่ระบุแผนก";
    text.append(name, meta);
    label.append(checkbox, text);
    container.append(label);
  });

  updateSpecialOtSelectedCount();
}

function getNextCalendarDateValue(dateValue) {
  const match = String(dateValue || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateValue || "";
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getSpecialOtFormData() {
  const employeesByKey = new Map(getSelectableSpecialOtEmployees().map((employee) => [employee.key, employee]));
  const selectedEmployees = [...specialOtSelectedEmployeeKeys]
    .map((key) => employeesByKey.get(key))
    .filter(Boolean);

  return {
    workDate: normalizeDate(document.querySelector("#specialOtWorkDate")?.value),
    endDate: normalizeDate(document.querySelector("#specialOtEndDate")?.value),
    endTime: normalizeTime(document.querySelector("#specialOtEndTime")?.value),
    reason: document.querySelector("#specialOtReason")?.value || "patient_watch",
    status: document.querySelector("#specialOtStatus")?.value || "pending",
    note: String(document.querySelector("#specialOtNote")?.value || "").trim(),
    employeeKeys: selectedEmployees.map((employee) => employee.key),
    employees: selectedEmployees.map((employee) => ({
      key: employee.key,
      fullName: employee.fullName,
      nickname: employee.nickname,
      department: employee.department,
    })),
  };
}

async function saveSpecialOtAssignment() {
  const message = document.querySelector("#specialOtMessage");
  const button = document.querySelector("#saveSpecialOtButton");
  const data = getSpecialOtFormData();

  if (!data.workDate || !data.endDate || !data.endTime) {
    message.textContent = "กรุณาระบุวันที่รอบงานและวันเวลาสิ้นสุด OT ให้ครบ";
    return;
  }
  if (data.endDate < data.workDate) {
    message.textContent = "วันสิ้นสุด OT ต้องไม่อยู่ก่อนวันที่รอบงาน";
    return;
  }
  if (!data.employeeKeys.length) {
    message.textContent = "กรุณาเลือกพนักงานอย่างน้อย 1 คน";
    return;
  }

  const now = new Date().toISOString();
  const id = `special-ot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const assignment = { ...data, id, createdAt: now, updatedAt: now };
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "กำลังบันทึก…";
  message.textContent = "";

  try {
    if (db) {
      await db.collection("special_ot_assignments").doc(id).set(assignment);
    }
    specialOtAssignmentsCache = [assignment, ...specialOtAssignmentsCache.filter((item) => item.id !== id)];
    persistSpecialOtAssignmentsLocally();
    renderSpecialOtAssignments();
    if (document.querySelector("#resultBody")) render();

    specialOtSelectedEmployeeKeys.clear();
    document.querySelector("#specialOtNote").value = "";
    renderSpecialOtEmployeeOptions();
    message.textContent = `บันทึก OT พิเศษสำหรับ ${assignment.employees.length} คนแล้ว`;
  } catch (err) {
    console.error("Failed to save special OT assignment:", err);
    message.textContent = `บันทึกไม่สำเร็จ: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function updateSpecialOtAssignmentStatus(id, status) {
  const assignment = specialOtAssignmentsCache.find((item) => item.id === id);
  if (!assignment) return;
  const updated = { ...assignment, status, updatedAt: new Date().toISOString() };

  try {
    if (db) {
      await db.collection("special_ot_assignments").doc(id).set(updated);
    }
    specialOtAssignmentsCache = specialOtAssignmentsCache.map((item) => item.id === id ? updated : item);
    persistSpecialOtAssignmentsLocally();
    renderSpecialOtAssignments();
    if (document.querySelector("#resultBody")) render();
  } catch (err) {
    console.error("Failed to update special OT assignment:", err);
    alert(`เปลี่ยนสถานะไม่สำเร็จ: ${err.message}`);
  }
}

async function deleteSpecialOtAssignment(id) {
  const assignment = specialOtAssignmentsCache.find((item) => item.id === id);
  if (!assignment || !confirm(`ลบ OT พิเศษวันที่ ${formatDisplayDate(assignment.workDate)} ใช่หรือไม่?`)) return;

  try {
    if (db) {
      await db.collection("special_ot_assignments").doc(id).delete();
    }
    specialOtAssignmentsCache = specialOtAssignmentsCache.filter((item) => item.id !== id);
    persistSpecialOtAssignmentsLocally();
    renderSpecialOtAssignments();
    if (document.querySelector("#resultBody")) render();
  } catch (err) {
    console.error("Failed to delete special OT assignment:", err);
    alert(`ลบไม่สำเร็จ: ${err.message}`);
  }
}

function renderSpecialOtAssignments() {
  const list = document.querySelector("#specialOtAssignmentList");
  const count = document.querySelector("#specialOtAssignmentCount");
  if (!list) return;

  const assignments = [...specialOtAssignmentsCache]
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  if (count) count.textContent = `${assignments.length} รายการ`;
  list.replaceChildren();

  if (!assignments.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "ยังไม่มี OT พิเศษ";
    list.append(empty);
    return;
  }

  assignments.forEach((assignment) => {
    const card = document.createElement("article");
    card.className = `special-ot-card ${assignment.status === "approved" ? "" : "pending"}`.trim();

    const head = document.createElement("div");
    head.className = "special-ot-card-head";
    const title = document.createElement("strong");
    title.textContent = `${formatDisplayDate(assignment.workDate)} · ${specialOtReasonLabels[assignment.reason] || assignment.reason}`;
    const badge = document.createElement("span");
    badge.className = `status ${assignment.status === "approved" ? "ok" : "warn"}`;
    badge.textContent = assignment.status === "approved" ? "อนุมัติแล้ว" : "รอตรวจสอบ";
    head.append(title, badge);

    const end = document.createElement("p");
    end.textContent = `คิด OT ได้ถึง ${formatDisplayDate(assignment.endDate)} เวลา ${assignment.endTime}`;
    const tags = document.createElement("div");
    tags.className = "employee-tags";
    (assignment.employees || []).forEach((employee) => {
      const tag = document.createElement("span");
      tag.className = "employee-tag";
      tag.textContent = employee.fullName;
      tags.append(tag);
    });

    if (assignment.note) {
      const note = document.createElement("p");
      note.textContent = assignment.note;
      card.append(head, end, tags, note);
    } else {
      card.append(head, end, tags);
    }

    const actions = document.createElement("div");
    actions.className = "employee-picker-actions";
    if (assignment.status !== "approved") {
      const approve = document.createElement("button");
      approve.className = "mini-action";
      approve.type = "button";
      approve.textContent = "อนุมัติ";
      approve.addEventListener("click", () => updateSpecialOtAssignmentStatus(assignment.id, "approved"));
      actions.append(approve);
    }
    const remove = document.createElement("button");
    remove.className = "mini-action danger-action";
    remove.type = "button";
    remove.textContent = "ลบ";
    remove.addEventListener("click", () => deleteSpecialOtAssignment(assignment.id));
    actions.append(remove);
    card.append(actions);
    list.append(card);
  });
}

const sampleRows = [
  {
    workDate: todayInputValue(),
    name: "ศศิกาญจน์ ชีวมงคลกานต์",
    department: "OR",
    startTime: "08:00",
    scanIn: "08:01",
    scanOut: "23:45",
    lastCaseEnd: "21:30",
  },
  {
    workDate: todayInputValue(),
    name: "Grace ABC",
    department: "MKT",
    startTime: "09:00",
    scanIn: "09:02",
    scanOut: "20:30",
    lastCaseEnd: "19:00",
  },
  {
    workDate: todayInputValue(),
    name: "มนัญญา สุขสิทธิ์",
    department: "CS",
    startTime: "08:00",
    scanIn: "07:58",
    scanOut: "18:15",
    lastCaseEnd: "17:30",
  },
  {
    workDate: todayInputValue(),
    name: "เพ็ญโฉม สุขสิทธิ์",
    department: "OR",
    startTime: "09:00",
    scanIn: "08:55",
    scanOut: "01:30",
    lastCaseEnd: "22:30",
  },
];

const columnAliases = {
  workDate: ["date", "work_date", "วันที่", "วัน", "workdate"],
  name: ["name", "ชื่อ", "ชื่อพนักงาน", "พนักงาน", "employee", "employee_name"],
  department: ["department", "dept", "แผนก"],
  startTime: ["start_time", "start", "เวลาเริ่มงาน", "เริ่มงาน"],
  scanIn: ["scan_in", "in", "เวลาเข้าจริง", "เวลาเข้า", "เข้าจริง"],
  scanOut: ["scan_out", "out", "เวลาออกจริง", "เวลาออก", "ออกจริง"],
  lastCaseEnd: ["last_case_end", "case_end", "เวลาเคสสุดท้ายเสร็จ", "เคสสุดท้าย"],
};

function todayInputValue() {
  const now = new Date();
  const timezoneOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - timezoneOffset).toISOString().slice(0, 10);
}

function formatDisplayDate(dateValue) {
  const isoDate = normalizeDate(dateValue);
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateValue || "-";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function parseDisplayDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return normalizeDate(text);
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function loadRules() {
  return rulesCache && rulesCache.length ? rulesCache : defaultRules;
}

async function saveRules(rules) {
  rulesCache = rules;
  if (db) {
    try {
      await db.collection("settings").doc("rules").set({ rules });
      console.log("Rules saved to Firebase Firestore.");
    } catch (err) {
      console.error("Failed to save rules to Firestore:", err);
    }
  }
}

function loadCaseSetting() {
  return { byDate: lastCasesCache };
}

function loadCaseSettingForDate(dateValue = getActiveWorkDate()) {
  return lastCasesCache[dateValue] || {};
}

async function saveCaseSettingForDate(dateValue, setting) {
  lastCasesCache[dateValue] = { ...setting, date: dateValue };
  if (db) {
    try {
      await db.collection("last_cases").doc(dateValue).set({ ...setting, date: dateValue });
      console.log("Case setting saved to Firebase Firestore.");
    } catch (err) {
      console.error("Failed to save case setting to Firestore:", err);
    }
  }
}

function loadLiffHistory() {
  return liffHistoryCache;
}

function loadLateRule() {
  return lateRuleCache || { ratePerMinute: 2, monthlyFreeMinutes: 15 };
}

async function saveLateRule(rule) {
  lateRuleCache = rule;
  if (db) {
    try {
      await db.collection("settings").doc("late_rule").set(rule);
      console.log("Late rule saved to Firebase Firestore.");
    } catch (err) {
      console.error("Failed to save late rule to Firestore:", err);
    }
  }
}

function loadOtRule() {
  return otRuleCache || { minThreshold: 15 };
}

async function saveOtRule(rule) {
  otRuleCache = rule;
  if (db) {
    try {
      await db.collection("settings").doc("ot_rule").set(rule);
      console.log("OT rule saved to Firebase Firestore.");
    } catch (err) {
      console.error("Failed to save OT rule to Firestore:", err);
    }
  }
}

function getActiveWorkDate() {
  return parseDisplayDate(document.querySelector("#caseDate")?.value || todayInputValue());
}

function openCaseDatePicker() {
  const nativeInput = document.querySelector("#caseDateNative");
  if (!nativeInput) return;

  if (typeof nativeInput.showPicker === "function") {
    try {
      nativeInput.showPicker();
      return;
    } catch {
      // Fall through to click for browsers that expose showPicker but block it.
    }
  }

  nativeInput.focus();
  nativeInput.click();
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function getCell(record, field) {
  const keys = Object.keys(record);
  const aliases = columnAliases[field].map(normalizeKey);
  const foundKey = keys.find((key) => aliases.includes(normalizeKey(key)));
  return foundKey ? record[foundKey] : "";
}

function normalizeRecord(record) {
  return {
    workDate: normalizeDate(getCell(record, "workDate")),
    name: String(getCell(record, "name") || "").trim(),
    department: String(getCell(record, "department") || "").trim().toUpperCase(),
    startTime: normalizeTime(getCell(record, "startTime")),
    scanIn: normalizeTime(getCell(record, "scanIn")),
    scanOut: normalizeTime(getCell(record, "scanOut")),
    lastCaseEnd: normalizeTime(getCell(record, "lastCaseEnd")),
  };
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") return "";

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    excelEpoch.setUTCDate(excelEpoch.getUTCDate() + value);
    return excelEpoch.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  const isoMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  }

  const thaiMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (thaiMatch) {
    return `${thaiMatch[3]}-${thaiMatch[2].padStart(2, "0")}-${thaiMatch[1].padStart(2, "0")}`;
  }

  const shortMatch = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
  if (shortMatch) {
    const year = new Date().getFullYear();
    return `${year}-${shortMatch[1].padStart(2, "0")}-${shortMatch[2].padStart(2, "0")}`;
  }

  return text;
}

function parseYearFromFileName(fileName) {
  const match = String(fileName || "").match(/(20\d{2})\d{4}/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

function dateFromMonthlyHeader(value, fileName) {
  const match = String(value || "").trim().match(/^(\d{1,2})-(\d{1,2})(?:\s+[\u0E00-\u0E7F]+)?$/);
  if (!match) return "";
  return `${parseYearFromFileName(fileName)}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function extractTimesFromScanCell(value) {
  const text = String(value || "");
  return [...text.matchAll(/\b\d{1,2}:\d{2}\b/g)]
    .map((match) => normalizeTime(match[0]))
    .filter(Boolean);
}

function parseMonthlyScanRows(matrix, fileName) {
  const header = matrix[1] || [];
  const parsedRows = [];

  let nameCol = 0;
  for (let i = 0; i < header.length; i++) {
    if (String(header[i] || "").trim() === "ชื่อบุคคล") {
      nameCol = i;
      break;
    }
  }

  for (const row of matrix.slice(2)) {
    const name = String(row[nameCol] || "").trim();
    if (!name || name.includes("NSC Clinic") || name === "ชื่อบุคคล") continue;

    for (let col = nameCol + 1; col < header.length; col += 1) {
      const workDate = dateFromMonthlyHeader(header[col], fileName);
      if (!workDate) continue;

      const times = extractTimesFromScanCell(row[col]);
      if (!times.length) continue;

      parsedRows.push({
        workDate,
        name,
        department: "",
        startTime: "",
        scanIn: times[0],
        scanOut: times[times.length - 1],
        lastCaseEnd: "",
      });
    }
  }

  return parsedRows;
}

function normalizeTime(value) {
  if (value === null || value === undefined || value === "") return "";

  if (typeof value === "number") {
    const totalMinutes = Math.round(value * 24 * 60);
    return minutesToTime(totalMinutes);
  }

  const text = String(value).trim().replace(".", ":");
  const match = text.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return "";

  const hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return "";

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeToMinutes(time, referenceStart = 0) {
  const [hour, minute] = time.split(":").map(Number);
  let total = hour * 60 + minute;
  if (total < referenceStart) total += 24 * 60;
  return total;
}

function sameDayTimeToMinutes(time) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatDuration(minutes) {
  if (minutes <= 0) return "0 นาที";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  if (!hour) return `${minute} นาที`;
  if (!minute) return `${hour} ชม.`;
  return `${hour} ชม. ${minute} นาที`;
}

function roundMinutes(minutes) {
  const mode = document.querySelector("#roundingMode")?.value || "actual";
  if (mode === "floor15") return Math.floor(minutes / 15) * 15;
  if (mode === "floor30") return Math.floor(minutes / 30) * 30;
  return minutes;
}

function getGlobalLastCaseTime(dateValue = getActiveWorkDate()) {
  const saved = loadCaseSettingForDate(dateValue);
  const hour = (document.querySelector("#lastCaseHour")?.value || saved.hour || "22").trim().padStart(2, "0");
  const minute = (document.querySelector("#lastCaseMinute")?.value || saved.minute || "30").trim().padStart(2, "0");
  return normalizeTime(`${hour}:${minute}`);
}

function getSavedLastCaseTime(dateValue) {
  const saved = loadCaseSettingForDate(dateValue);
  if (!saved.hour && !saved.minute) return "";
  const hour = String(saved.hour || "0").trim().padStart(2, "0");
  const minute = String(saved.minute || "0").trim().padStart(2, "0");
  return normalizeTime(`${hour}:${minute}`);
}

function getDepartmentRule(department) {
  const normalized = String(department || "").trim().toUpperCase();
  const rules = loadRules();
  const matched = rules.find((rule) => rule.department === normalized);
  const fallback = rules.find((rule) => rule.department === "OTHER") || defaultRules[2];
  const rule = matched || fallback;

  return {
    ...rule,
    label: matched ? rule.department : "OTHER",
    bufferMinutes: Number(rule.bufferHours || 1) * 60,
  };
}

function findSpecialOtAssignment(row) {
  const employeeKey = normalizeName(row.name);
  const workDate = normalizeDate(row.workDate);
  if (!employeeKey || !workDate) return null;

  return [...specialOtAssignmentsCache]
    .filter((assignment) => {
      const employeeKeys = Array.isArray(assignment.employeeKeys)
        ? assignment.employeeKeys
        : (assignment.employees || []).map((employee) => normalizeName(employee.fullName));
      return normalizeDate(assignment.workDate) === workDate && employeeKeys.includes(employeeKey);
    })
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0] || null;
}

function specialOtEndToMinutes(assignment, workDate) {
  if (!assignment?.endDate || !assignment?.endTime || !workDate) return null;
  const workMatch = String(workDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const endMatch = String(assignment.endDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!workMatch || !endMatch) return null;

  const workDay = Date.UTC(Number(workMatch[1]), Number(workMatch[2]) - 1, Number(workMatch[3]));
  const endDay = Date.UTC(Number(endMatch[1]), Number(endMatch[2]) - 1, Number(endMatch[3]));
  const dayDifference = Math.round((endDay - workDay) / 86400000);
  if (dayDifference < 0) return null;
  return dayDifference * 24 * 60 + sameDayTimeToMinutes(assignment.endTime);
}

function calculateSplitRateAmount(otStart, otEnd, rule) {
  const nightStart = 23 * 60;
  const nextMorning = 32 * 60;
  const cappedEnd = Math.min(otEnd, nextMorning);
  const baseBeforeNight = Math.max(0, Math.min(cappedEnd, nightStart) - otStart);
  const nightMinutes = Math.max(0, Math.min(cappedEnd, nextMorning) - Math.max(otStart, nightStart));
  const afterMorningMinutes = Math.max(0, otEnd - nextMorning);

  const baseRounded = roundMinutes(baseBeforeNight);
  const nightRounded = roundMinutes(nightMinutes);

  return {
    amount: (baseRounded / 60) * Number(rule.flatRate || 0) + (nightRounded / 60) * Number(rule.nightRate || 0),
    paidMinutes: baseRounded + nightRounded,
    breakdown: [
      baseRounded ? `${rule.flatRate} บาท: ${formatDuration(baseRounded)}` : "",
      nightRounded ? `${rule.nightRate} บาท: ${formatDuration(nightRounded)}` : "",
      afterMorningMinutes ? `หลัง 08:00 นับเป็นวันใหม่: ${formatDuration(afterMorningMinutes)}` : "",
    ]
      .filter(Boolean)
      .join(" / "),
  };
}

function calculateRow(row) {
  const liffLog = findLiffLog(row);
  const startTime = row.startTime || liffLog?.plannedStartTime || "";
  const department = getEffectiveDepartment(row) || liffLog?.department || "";
  const workDate = row.workDate || liffLog?.workDate || "";
  const rule = getDepartmentRule(department);
  const specialOtAssignment = findSpecialOtAssignment({ ...row, workDate });
  if (!startTime) {
    return {
      ...row,
      workDate,
      liffLog,
      missingStartTime: true,
      rule,
    };
  }

  const startMinutes = sameDayTimeToMinutes(startTime);
  const scanInMinutes = row.scanIn ? sameDayTimeToMinutes(row.scanIn) : null;
  const lateRule = loadLateRule();
  const rawLateMinutes = scanInMinutes === null ? null : Math.max(0, scanInMinutes - startMinutes);
  const lateMinutes = rawLateMinutes;
  const lateDeduction = lateMinutes === null ? 0 : lateMinutes * Number(lateRule.ratePerMinute || 0);
  const scheduledEnd = startMinutes + 9 * 60;
  const specialOtEndCandidate = specialOtAssignment
    ? specialOtEndToMinutes(specialOtAssignment, workDate)
    : null;
  let outMinutes = timeToMinutes(row.scanOut, startMinutes);
  // เวลาเข้าและออกเท่ากัน เช่น 08:00 → 08:00 ต้องใช้วันที่สิ้นสุด OT พิเศษ
  // เพื่อยืนยันว่าเวลาออกเป็น 08:00 ของวันถัดไป ไม่ใช่เวลาเดียวกันในวันเดิม
  if (specialOtEndCandidate >= 24 * 60 && outMinutes === startMinutes) {
    outMinutes += 24 * 60;
  }
  const earlyLeaveMinutes = Math.max(0, scheduledEnd - outMinutes);

  // Dynamic OT threshold logic
  const otRule = loadOtRule();
  const minThreshold = Number(otRule.minThreshold ?? 15);
  const rawOtMinutes = Math.max(0, outMinutes - scheduledEnd);
  const isOtEligible = rawOtMinutes >= minThreshold;
  const actualOtMinutes = isOtEligible ? roundMinutes(rawOtMinutes) : 0;

  const lastCaseTime = row.lastCaseEnd || getSavedLastCaseTime(workDate);
  const specialOtApproved = specialOtAssignment?.status === "approved";
  const specialOtPending = Boolean(specialOtAssignment && !specialOtApproved);
  const specialOtEndMinutes = specialOtApproved
    ? specialOtEndCandidate
    : null;
  const hasValidSpecialOtEnd = specialOtEndMinutes !== null && specialOtEndMinutes >= scheduledEnd;
  const missingLastCase = !lastCaseTime && !hasValidSpecialOtEnd;
  const lastCaseMinutes = lastCaseTime ? timeToMinutes(lastCaseTime, startMinutes) : null;
  const cutoff = lastCaseMinutes === null ? null : lastCaseMinutes + rule.bufferMinutes;
  // overCaseLimit: only meaningful when last case ends AFTER the scheduled end time.
  // Scenario A — last case after scheduledEnd (e.g., case 22:00, end 18:00):
  //   employee may stay late due to the case → cap OT at lastCase + buffer, flag if exceeded.
  // Scenario B — last case before scheduledEnd (e.g., case 12:42, end 18:00):
  //   employee working normal hours → no case-limit concern at all.
  const lastCaseAfterScheduledEnd = lastCaseMinutes !== null && lastCaseMinutes > scheduledEnd;
  // OT พิเศษที่อนุมัติแล้วมีลำดับเหนือเคสสุดท้าย + buffer และผูกกับพนักงานรายคน
  const effectiveCutoff = hasValidSpecialOtEnd
    ? specialOtEndMinutes
    : lastCaseAfterScheduledEnd ? cutoff : null;
  const cutoffSource = hasValidSpecialOtEnd ? "special_ot" : effectiveCutoff !== null ? "last_case" : "";
  const overCaseLimit = effectiveCutoff !== null && outMinutes > effectiveCutoff;
  const hasOtIntent = Boolean(liffLog?.employeeOtIntent);
  const hasOtWithoutIntent = actualOtMinutes > 0 && !hasOtIntent;
  // payableOutMinutes is capped at effectiveCutoff only when last case ran past scheduled end
  const payableOutMinutes = effectiveCutoff === null ? outMinutes : Math.min(outMinutes, effectiveCutoff);
  // excessAfterCaseMinutes: minutes beyond the effective cutoff
  const excessAfterCaseMinutes = effectiveCutoff === null ? 0 : Math.max(0, outMinutes - effectiveCutoff);

  let payableOtMinutes = 0;
  let amount = 0;
  let breakdown = "";

  // missingLastCase only matters when employee is actually working OT.
  // If they leave on time, there is nothing to cap or flag.
  const otNeedsLastCase = isOtEligible && hasOtIntent;
  if (specialOtPending && otNeedsLastCase) {
    amount = 0;
    payableOtMinutes = 0;
    breakdown = "OT พิเศษรอตรวจสอบ";
  } else if (missingLastCase && otNeedsLastCase) {
    amount = 0;
    payableOtMinutes = 0;
    breakdown = "ยังไม่มีข้อมูลเคสสุดท้าย";
  } else if (!hasOtIntent || !isOtEligible) {
    amount = 0;
    payableOtMinutes = 0;
    breakdown = !isOtEligible ? `โอทีไม่ถึง ${minThreshold} นาที` : "ยังไม่กดว่ามี OT";
  } else if (rule.useNightRate) {
    const splitResult = calculateSplitRateAmount(scheduledEnd, payableOutMinutes, rule);
    amount = splitResult.amount;
    payableOtMinutes = splitResult.paidMinutes;
    breakdown = splitResult.breakdown;
  } else {
    payableOtMinutes = roundMinutes(Math.max(0, payableOutMinutes - scheduledEnd));
    amount = (payableOtMinutes / 60) * rule.flatRate;
    breakdown = `${rule.flatRate} บาท: ${formatDuration(payableOtMinutes)}`;
  }

  return {
    ...row,
    rowKey: row.rowKey,
    workDate,
    startTime,
    department,
    liffLog,
    specialOtAssignment,
    specialOtApproved,
    specialOtPending,
    scanIn: row.scanIn,
    lateMinutes,
    lateDeductibleMinutes: lateMinutes || 0,
    monthlyLateMinutes: lateMinutes || 0,
    monthlyFreeMinutes: Number(lateRule.monthlyFreeMinutes || 0),
    lateDeduction,
    earlyLeaveMinutes,
    lateRule,
    rule,
    scheduledEnd: minutesToTime(scheduledEnd),
    actualOtMinutes,
    payableOtMinutes,
    excessAfterCaseMinutes,
    hasOtIntent,
    hasOtWithoutIntent,
    amount,
    breakdown,
    lastCaseTime,
    missingLastCase,
    cutoff: effectiveCutoff === null ? "" : minutesToTime(effectiveCutoff),
    cutoffSource,
    overCaseLimit,
    newDayAfter8: rule.useNightRate && outMinutes > 32 * 60,
  };
}

function normalizeName(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function getExcelDateKey(dateValue) {
  if (!dateValue) return "";
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}-${date.getDate()}`;
}

function findLiffLog(row) {
  const history = loadLiffHistory();
  const rowName = normalizeName(row.name);
  const rowDate = row.workDate;
  const rowDateKey = getExcelDateKey(rowDate);

  return history.find((item) => {
    const sameDate = item.workDate === rowDate || item.excelDateKey === rowDateKey;
    const sameName = normalizeName(item.fullName) === rowName || normalizeName(item.nickname) === rowName;
    return sameDate && sameName;
  });
}

function getMonthKey(dateValue) {
  const normalized = normalizeDate(dateValue);
  const match = normalized.match(/^(\d{4})-(\d{2})-/);
  return match ? `${match[1]}-${match[2]}` : "";
}

function applyMonthlyLatePolicy(calculated) {
  const lateRule = loadLateRule();
  const freeMinutes = Number(lateRule.monthlyFreeMinutes || 0);
  const ratePerMinute = Number(lateRule.ratePerMinute || 0);
  const groups = new Map();

  for (const row of calculated) {
    const key = `${normalizeName(row.name)}-${getMonthKey(row.workDate)}`;
    if (!row.name || !getMonthKey(row.workDate) || !row.lateMinutes) {
      row.lateDeductibleMinutes = 0;
      row.monthlyLateMinutes = row.lateMinutes || 0;
      row.monthlyFreeMinutes = freeMinutes;
      row.lateDeduction = 0;
      continue;
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  for (const groupRows of groups.values()) {
    groupRows.sort((a, b) => String(a.workDate).localeCompare(String(b.workDate)));
    const monthlyLateMinutes = groupRows.reduce((sum, row) => sum + Number(row.lateMinutes || 0), 0);
    let freeRemaining = freeMinutes;

    for (const row of groupRows) {
      const lateMinutes = Number(row.lateMinutes || 0);
      const freeUsed = Math.min(freeRemaining, lateMinutes);
      const deductibleMinutes = Math.max(0, lateMinutes - freeUsed);
      freeRemaining = Math.max(0, freeRemaining - freeUsed);

      row.monthlyLateMinutes = monthlyLateMinutes;
      row.monthlyFreeMinutes = freeMinutes;
      row.lateDeductibleMinutes = deductibleMinutes;
      row.lateDeduction = deductibleMinutes * ratePerMinute;
    }
  }

  return calculated;
}

function render() {
  const body = document.querySelector("#resultBody");
  const calculated = applyMonthlyLatePolicy(rows.filter((row) => row.name && row.scanOut).map(calculateRow));

  if (!calculated.length) {
    body.innerHTML = `<tr><td colspan="10" class="empty-state">ยังไม่มีข้อมูล กดโหลดตัวอย่างหรือเลือกไฟล์ Excel</td></tr>`;
    updateSummary([]);
    return;
  }

  const grouped = {};
  for (const row of calculated) {
    const key = normalizeName(row.name);
    if (!grouped[key]) grouped[key] = { name: row.name, rows: [], department: row.department, rule: row.rule };
    grouped[key].rows.push(row);
  }

  const html = [];
  for (const key of Object.keys(grouped)) {
    const group = grouped[key];
    const totalAmount = group.rows.reduce((sum, r) => sum + (r.amount || 0), 0);
    const totalLate = group.rows.reduce((sum, r) => sum + (r.lateMinutes || 0), 0);
    const totalOt = group.rows.reduce((sum, r) => sum + (r.actualOtMinutes || 0), 0);
    const days = group.rows.length;
    
    html.push(`
      <tr class="summary-row" data-name="${escapeHtml(key)}" style="cursor: pointer; background: #fdfdfd; border-top: 2px solid #eee;">
        <td><strong>▶ ${escapeHtml(group.name)}</strong><br><small>${days} วัน</small></td>
        <td>-</td>
        <td>${renderGroupDepartmentSelect(group)}</td>
        <td>-</td>
        <td>-</td>
        <td>${totalLate > 0 ? `<span class="status warn">สายรวม ${formatDuration(totalLate)}</span>` : "-"}</td>
        <td>-</td>
        <td>${totalOt > 0 ? formatDuration(totalOt) : "-"}</td>
        <td class="amount"><strong>${formatMoney(totalAmount)}</strong></td>
        <td><small>คลิกเพื่อดูรายละเอียด</small></td>
      </tr>
    `);

    for (const row of group.rows) {
      let rowHtml = renderRow(row);
      rowHtml = rowHtml.replace('<tr>', `<tr class="detail-row detail-${escapeHtml(key)}" style="display: none; background: #fafafa;">`);
      rowHtml = rowHtml.replace(`<td><strong>${escapeHtml(row.name)}</strong></td>`, `<td></td>`);
      html.push(rowHtml);
    }
  }

  body.innerHTML = html.join("");
  bindDepartmentSelects();
  bindGroupToggles();
  updateSummary(calculated);
}

function bindGroupToggles() {
  for (const row of document.querySelectorAll(".summary-row")) {
    row.addEventListener("click", (e) => {
      if (e.target.tagName === 'SELECT') return;
      const key = row.dataset.name;
      const details = document.querySelectorAll(`.detail-${key}`);
      if (!details.length) return;
      const isHidden = details[0].style.display === "none";
      details.forEach(d => d.style.display = isHidden ? "" : "none");
      
      const firstTd = row.querySelector("td strong");
      if (firstTd) {
        if (isHidden) {
          firstTd.innerHTML = firstTd.innerHTML.replace("▶", "▼");
        } else {
          firstTd.innerHTML = firstTd.innerHTML.replace("▼", "▶");
        }
      }
    });
  }
}

function renderGroupDepartmentSelect(group) {
  const rules = loadRules();
  const currentDepartment = String(group.department || group.rule?.label || "OTHER").trim().toUpperCase();
  const departments = Array.from(
    new Set([...rules.map((rule) => rule.department), String(currentDepartment || "").trim().toUpperCase()].filter(Boolean)),
  );
  const options = departments
    .map((rule) => {
      const selected = rule === currentDepartment ? "selected" : "";
      return `<option value="${escapeHtml(rule)}" ${selected}>${escapeHtml(rule)}</option>`;
    })
    .join("");

  return `<select class="department-select" data-group-name="${escapeHtml(normalizeName(group.name))}">${options}</select>`;
}

function bindDepartmentSelects() {
  for (const select of document.querySelectorAll(".department-select")) {
    select.addEventListener("change", () => {
      if (select.dataset.rowKey) {
        const row = rows.find((item) => item.rowKey === select.dataset.rowKey);
        if (!row) return;
        row.department = select.value;
      } else if (select.dataset.groupName) {
        const groupName = select.dataset.groupName;
        for (const row of rows) {
          if (normalizeName(row.name) === groupName) {
            row.department = select.value;
          }
        }
      }
      render();
    });
  }
}

function renderRow(row) {
  if (row.missingStartTime) {
    return `
        <tr>
          <td><strong>${escapeHtml(row.name)}</strong></td>
        <td>${escapeHtml(formatDisplayDate(row.workDate))}</td>
        <td>${renderDepartmentSelect(row)}</td>
        <td><span class="status danger">ไม่พบเวลาเริ่มจาก LIFF/Excel</span></td>
        <td>${row.scanOut || "-"}</td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
        <td class="amount">0 บาท</td>
        <td><span class="status danger">ต้องมี History LIFF หรือ Start_Time</span></td>
      </tr>
    `;
  }

  // missingLastCase is only relevant (warn) when the employee actually has OT intent and is eligible.
  const warnMissingLastCase = row.missingLastCase && row.actualOtMinutes > 0 && row.hasOtIntent;
  const warnSpecialOtPending = row.specialOtPending && row.actualOtMinutes > 0 && row.hasOtIntent;
  const statusClass = row.hasOtWithoutIntent || row.overCaseLimit || warnMissingLastCase || warnSpecialOtPending ? "warn" : "ok";
  const statusText = row.hasOtWithoutIntent
    ? "สแกนเกิน แต่ LIFF ไม่ได้กด OT"
    : warnSpecialOtPending
      ? "OT พิเศษรอตรวจสอบ"
      : warnMissingLastCase
        ? "ยังไม่มีข้อมูลเคสสุดท้ายของวันนี้"
        : row.overCaseLimit
          ? row.cutoffSource === "special_ot" ? "เกินเวลา OT ที่อนุมัติ" : "เกินเวลาเคส ให้ HR ตรวจ"
          : "อยู่ในเงื่อนไข";
  const newDayNote = row.newDayAfter8 ? `<div class="status warn">หลัง 08:00 นับวันใหม่</div>` : "";
  const excessNote = row.excessAfterCaseMinutes
    ? `<div class="status warn">เกิน cutoff ${formatDuration(row.excessAfterCaseMinutes)} ไม่คิดเงินอัตโนมัติ</div>`
    : "";
  const noOtIntentNote = row.hasOtWithoutIntent
    ? `<div class="status warn">ไม่คิดเงิน เพราะไม่ได้กดว่ามี OT</div>`
    : "";
  const otNoteFromLiff = row.liffLog?.otNote
    ? `<div class="status ok" style="margin-top:4px;">📝 ${escapeHtml(row.liffLog.otNote)}</div>`
    : "";
  const otIntentBadge = row.liffLog
    ? (row.liffLog.employeeOtIntent
        ? `<div class="status ok">✅ พนักงานกดว่ามี OT</div>`
        : `<div class="status warn">❌ ยังไม่ได้กด OT / ไม่มี OT</div>`)
    : "";
  const specialOtBadge = row.specialOtAssignment
    ? `<div class="status ${row.specialOtApproved ? "ok" : "warn"}">งานต่อเนื่อง: ${escapeHtml(specialOtReasonLabels[row.specialOtAssignment.reason] || row.specialOtAssignment.reason)}</div>`
    : "";
  const approvalSource = row.specialOtAssignment
    ? `OT พิเศษ ${row.specialOtApproved ? "อนุมัติแล้ว" : "รอตรวจสอบ"}<br>
       <small>ถึง ${escapeHtml(formatDisplayDate(row.specialOtAssignment.endDate))} ${escapeHtml(row.specialOtAssignment.endTime || "-")}</small><br>`
    : `เคสเสร็จ ${row.lastCaseTime || "-"}<br>`;

  return `
    <tr>
      <td><strong>${escapeHtml(row.name)}</strong></td>
      <td>${escapeHtml(formatDisplayDate(row.workDate))}</td>
      <td>${renderDepartmentSelect(row)}</td>
      <td>${row.startTime}<br><small>เลิกปกติ ${row.scheduledEnd}</small>${row.liffLog ? '<br><small>จาก LIFF</small>' : ""}</td>
      <td>${row.scanOut}</td>
      <td>${renderLateCell(row)}</td>
      <td>${renderEarlyLeaveCell(row)}</td>
      <td>
        คิดเงินได้ ${formatDuration(row.payableOtMinutes)}<br>
        <small>สแกนจริง ${formatDuration(row.actualOtMinutes)}</small><br>
        <small>${escapeHtml(row.breakdown)}</small>${newDayNote}${excessNote}${noOtIntentNote}${otIntentBadge}${otNoteFromLiff}${specialOtBadge}
      </td>
      <td class="amount">${formatMoney(row.amount)}</td>
      <td>
        ${approvalSource}
        ${row.cutoff ? `<small>ควรออกไม่เกิน ${row.cutoff}</small><br>` : ""}
        <span class="status ${statusClass}">${statusText}</span>
      </td>
    </tr>
  `;
}

function renderDepartmentSelect(row) {
  const rules = loadRules();
  const currentDepartment = String(row.department || row.rule?.label || "OTHER").trim().toUpperCase();
  const departments = Array.from(
    new Set([...rules.map((rule) => rule.department), String(currentDepartment || "").trim().toUpperCase()].filter(Boolean)),
  );
  const options = departments
    .map((rule) => {
      const selected = rule === currentDepartment ? "selected" : "";
      return `<option value="${escapeHtml(rule)}" ${selected}>${escapeHtml(rule)}</option>`;
    })
    .join("");

  return `<select class="department-select" data-row-key="${escapeHtml(row.rowKey)}">${options}</select>`;
}

function renderLateCell(row) {
  if (!row.scanIn) return `<span class="status warn">ไม่มี scan in</span>`;
  if (!row.lateMinutes) return `${row.scanIn}<br><span class="status ok">ไม่สาย</span>`;
  const deductibleText = row.lateDeductibleMinutes
    ? `<small>หักจริง ${formatDuration(row.lateDeductibleMinutes)} = ${formatMoney(row.lateDeduction)}</small>`
    : `<small>ยังอยู่ในโควตาฟรี ${formatDuration(row.monthlyFreeMinutes || 0)}/เดือน</small>`;

  return `
    ${row.scanIn}<br>
    <span class="status warn">สาย ${formatDuration(row.lateMinutes)}</span><br>
    <small>เดือนนี้รวม ${formatDuration(row.monthlyLateMinutes || row.lateMinutes)}</small><br>
    ${deductibleText}
  `;
}

function renderEarlyLeaveCell(row) {
  if (!row.scanOut) return `<span class="status warn">ไม่มี scan out</span>`;
  if (!row.earlyLeaveMinutes) return `${row.scanOut}<br><span class="status ok">ไม่ออกก่อน</span>`;

  return `
    ${row.scanOut}<br>
    <span class="status warn">ออกก่อน ${formatDuration(row.earlyLeaveMinutes)}</span>
  `;
}

function updateSummary(calculated) {
  const total = calculated.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const uniqueNames = new Set(calculated.map(r => normalizeName(r.name)));
  document.querySelector("#totalPeople").textContent = `${uniqueNames.size} คน`;
  document.querySelector("#totalAmount").textContent = formatMoney(total);
}

function formatMoney(value) {
  return `${Math.round(value).toLocaleString("th-TH")} บาท`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function setRows(nextRows) {
  rows.length = 0;
  rows.push(
    ...nextRows.map((row, index) => ({
      ...row,
      rowKey: row.rowKey || `${row.workDate || "nodate"}-${row.name || "noname"}-${index}`,
    })),
  );
  renderSpecialOtEmployeeOptions();
  render();
}

function getCaseSettingFromForm() {
  const saved = loadCaseSettingForDate();
  return {
    date: getActiveWorkDate(),
    task: (document.querySelector("#lastCaseTask")?.value || saved.task || "").trim(),
    hour: (document.querySelector("#lastCaseHour")?.value || saved.hour || "22").trim().padStart(2, "0"),
    minute: (document.querySelector("#lastCaseMinute")?.value || saved.minute || "30").trim().padStart(2, "0"),
    note: (document.querySelector("#lastCaseNote")?.value || saved.note || "").trim(),
  };
}

function applyCaseSetting(setting, selectedDate = getActiveWorkDate()) {
  if (document.querySelector("#caseDate")) {
    document.querySelector("#caseDate").value = formatDisplayDate(setting.date || selectedDate);
  }
  if (document.querySelector("#caseDateNative")) {
    document.querySelector("#caseDateNative").value = normalizeDate(setting.date || selectedDate);
  }

  if (!document.querySelector("#lastCaseTask")) {
    renderCaseSummary();
    return;
  }

  document.querySelector("#lastCaseTask").value = setting.task || "";
  document.querySelector("#lastCaseHour").value = setting.hour || "22";
  document.querySelector("#lastCaseMinute").value = setting.minute || "30";
  document.querySelector("#lastCaseNote").value = setting.note || "";
  renderCaseSummary();
}

function renderCaseSummary() {
  const setting = getCaseSettingFromForm();
  const time = getGlobalLastCaseTime() || "--:--";
  const caseSummaryTime = document.querySelector("#caseSummaryTime");
  const lastCaseDisplay = document.querySelector("#lastCaseDisplay");
  const caseSummaryText = document.querySelector("#caseSummaryText");

  if (caseSummaryTime) caseSummaryTime.textContent = time;
  if (lastCaseDisplay) lastCaseDisplay.value = `${setting.task || "เคสสุดท้าย"} ${time}`;
  if (caseSummaryText) caseSummaryText.textContent = `${formatDisplayDate(setting.date || getActiveWorkDate())} · ${setting.note || setting.task || "ใช้เป็นเวลาเคสสุดท้ายของทุกคนในวันนั้น"}`;
}

async function saveCaseFromForm() {
  const setting = getCaseSettingFromForm();
  if (!setting.date || !normalizeTime(`${setting.hour}:${setting.minute}`)) {
    alert("กรุณาเลือกวันที่และกรอกเวลาเคสสุดท้ายให้ถูกต้อง");
    return;
  }

  await saveCaseSettingForDate(setting.date || getActiveWorkDate(), setting);
  renderCaseSummary();

  const message = document.querySelector("#caseSaveMessage");
  if (message) {
    message.textContent = `บันทึกเคสวันที่ ${formatDisplayDate(setting.date)} เวลา ${setting.hour}:${setting.minute} แล้ว`;
  }
}

function renderRules() {
  const rules = loadRules();
  const rulesCount = document.querySelector("#rulesCount");
  const rulesBody = document.querySelector("#rulesBody");
  if (rulesCount) rulesCount.textContent = `${rules.length} แผนก`;
  if (!rulesBody) return;

  rulesBody.innerHTML = rules
    .map(
      (rule) => `
        <tr>
          <td><strong>${escapeHtml(rule.department)}</strong></td>
          <td>${formatMoney(Number(rule.flatRate || 0))}</td>
          <td>${rule.useNightRate ? `23:00-08:00 = ${formatMoney(Number(rule.nightRate || 0))}` : "-"}</td>
          <td>${Number(rule.bufferHours || 1)} ชม.</td>
          <td>
            <div class="table-actions">
              <button class="mini-action" type="button" data-edit-rule="${escapeHtml(rule.department)}">แก้ไข</button>
              <button class="mini-action danger-action" type="button" data-delete-rule="${escapeHtml(rule.department)}">ลบ</button>
            </div>
          </td>
        </tr>
      `,
    )
    .join("");

  for (const button of document.querySelectorAll("[data-edit-rule]")) {
    button.addEventListener("click", () => fillRuleForm(button.dataset.editRule));
  }
  for (const button of document.querySelectorAll("[data-delete-rule]")) {
    button.addEventListener("click", () => deleteRule(button.dataset.deleteRule));
  }
}

function fillRuleForm(department) {
  if (!document.querySelector("#ruleDepartment")) return;
  const rule = loadRules().find((item) => item.department === department);
  if (!rule) return;

  document.querySelector("#ruleDepartment").value = rule.department;
  document.querySelector("#ruleFlatRate").value = rule.flatRate;
  document.querySelector("#ruleBufferHours").value = rule.bufferHours;
  document.querySelector("#ruleUseNightRate").checked = Boolean(rule.useNightRate);
  document.querySelector("#ruleNightRate").value = rule.nightRate || "";
  const message = document.querySelector("#ruleSaveMessage");
  if (message) message.textContent = `กำลังแก้ไขแผนก ${rule.department}`;
}

function clearRuleForm() {
  if (!document.querySelector("#ruleDepartment")) return;
  document.querySelector("#ruleDepartment").value = "";
  document.querySelector("#ruleFlatRate").value = "";
  document.querySelector("#ruleBufferHours").value = "";
  document.querySelector("#ruleUseNightRate").checked = false;
  document.querySelector("#ruleNightRate").value = "";
  const message = document.querySelector("#ruleSaveMessage");
  if (message) message.textContent = "กรอกข้อมูลเพื่อเพิ่มแผนกใหม่";
}

async function deleteRule(department) {
  const rules = loadRules();
  if (rules.length <= 1) {
    alert("ต้องเหลือกฎแผนกอย่างน้อย 1 รายการ");
    return;
  }

  const nextRules = rules.filter((rule) => rule.department !== department);
  await saveRules(nextRules);
  renderRules();
  if (document.querySelector("#resultBody")) render();

  const message = document.querySelector("#ruleSaveMessage");
  if (message) message.textContent = `ลบแผนก ${department} แล้ว`;
}

async function saveRuleFromForm() {
  if (!document.querySelector("#ruleDepartment")) return;
  const department = document.querySelector("#ruleDepartment").value.trim().toUpperCase();
  const flatRateInput = document.querySelector("#ruleFlatRate").value.trim();
  const flatRate = Number(flatRateInput);
  const bufferHours = Number(document.querySelector("#ruleBufferHours").value || 1);
  const useNightRate = document.querySelector("#ruleUseNightRate").checked;
  const nightRate = Number(document.querySelector("#ruleNightRate").value || 0);

  if (!department || flatRateInput === "" || Number.isNaN(flatRate)) {
    alert("กรุณากรอกรหัสแผนกและค่า OT/ชม.");
    return;
  }

  const rules = loadRules();
  const nextRule = {
    department,
    flatRate,
    bufferHours,
    useNightRate,
    nightRate: useNightRate ? nightRate : 0,
  };
  const index = rules.findIndex((rule) => rule.department === department);
  if (index >= 0) {
    rules[index] = nextRule;
  } else {
    rules.push(nextRule);
  }

  await saveRules(rules);
  renderRules();
  if (document.querySelector("#resultBody")) render();
  clearRuleForm();
  const message = document.querySelector("#ruleSaveMessage");
  if (message) message.textContent = `${index >= 0 ? "แก้ไข" : "เพิ่ม"}แผนก ${department} แล้ว`;
}

function applyLateRule() {
  const rule = loadLateRule();
  const rateInput = document.querySelector("#lateRatePerMinute");
  const freeInput = document.querySelector("#lateMonthlyFreeMinutes");
  if (rateInput) rateInput.value = rule.ratePerMinute ?? 2;
  if (freeInput) freeInput.value = rule.monthlyFreeMinutes ?? 15;
}

async function saveLateRuleFromForm() {
  const ratePerMinute = Number(document.querySelector("#lateRatePerMinute")?.value || 0);
  const monthlyFreeMinutes = Number(document.querySelector("#lateMonthlyFreeMinutes")?.value || 0);

  await saveLateRule({ ratePerMinute, monthlyFreeMinutes });
  const message = document.querySelector("#lateRuleMessage");
  if (message) message.textContent = `บันทึกกฎมาสายแล้ว: ฟรี ${monthlyFreeMinutes} นาที/เดือน, หักนาทีละ ${ratePerMinute} บาท`;
  if (document.querySelector("#resultBody")) render();
}

function applyOtRule() {
  const rule = loadOtRule();
  const thresholdInput = document.querySelector("#otMinThreshold");
  if (thresholdInput) thresholdInput.value = rule.minThreshold ?? 15;
}

async function saveOtRuleFromForm() {
  const minThreshold = Number(document.querySelector("#otMinThreshold")?.value || 0);

  await saveOtRule({ minThreshold });
  const message = document.querySelector("#otRuleMessage");
  if (message) message.textContent = `บันทึกเกณฑ์ขั้นต่ำโอทีแล้ว: เริ่มคิดโอทีเมื่อทำครบ ${minThreshold} นาทีขึ้นไป`;
  if (document.querySelector("#resultBody")) render();
}

async function renderHistoryPage() {
  await fetchLiffHistoryFromFirestore();
  renderLiffHistory();
  renderCaseHistory();
}

function formatThaiMonthYear(yearMonthStr) {
  const parts = String(yearMonthStr || "").split("-");
  if (parts.length < 2) return yearMonthStr || "";
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const monthNames = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
  ];
  const thaiYear = y + 543;
  return `${monthNames[m - 1]} ${thaiYear}`;
}

function updateFilterOptions(selectElement, uniqueItems) {
  if (!selectElement) return;
  const currentVal = selectElement.value;
  const newOptionsHTML = `<option value="">ทั้งหมด</option>` + uniqueItems.map(item => {
    return `<option value="${item}">${formatThaiMonthYear(item)}</option>`;
  }).join("");
  
  if (selectElement.innerHTML !== newOptionsHTML) {
    selectElement.innerHTML = newOptionsHTML;
    if (Array.from(selectElement.options).some(opt => opt.value === currentVal)) {
      selectElement.value = currentVal;
    } else {
      selectElement.value = "";
    }
  }
}

async function deleteLiffHistoryItem(docId) {
  if (!confirm("ยืนยันการลบรายการประวัตินี้ใช่หรือไม่?")) return;

  if (db) {
    try {
      await db.collection("attendance_history").doc(docId).delete();
      console.log("LIFF history document deleted from Firestore:", docId);
    } catch (err) {
      console.error("Failed to delete LIFF history from Firestore:", err);
      alert("ลบข้อมูลจาก Firebase ล้มเหลว: " + err.message);
      return;
    }
  }

  try {
    if (docId.includes("_")) {
      const [lineUserId, cycleDate] = docId.split("_");
      liffHistoryCache = liffHistoryCache.filter(item => !(item.id === docId || (item.lineUserId === lineUserId && (item.cycleDate || item.workDate) === cycleDate)));
    } else {
      liffHistoryCache = liffHistoryCache.filter(item => item.id !== docId);
    }
  } catch (err) {
    console.error("Failed to update cache history:", err);
  }

  renderLiffHistory();
  if (document.querySelector("#resultBody")) render();
  alert("ลบข้อมูลสำเร็จ");
}

async function deleteCaseHistoryItem(dateValue) {
  if (!confirm(`ยืนยันการลบประวัติเคสวันที่ ${formatDisplayDate(dateValue)} ใช่หรือไม่?`)) return;

  if (db) {
    try {
      await db.collection("last_cases").doc(dateValue).delete();
      console.log("Last case document deleted from Firestore:", dateValue);
    } catch (err) {
      console.error("Failed to delete last case from Firestore:", err);
      alert("ลบข้อมูลจาก Firebase ล้มเหลว: " + err.message);
      return;
    }
  }

  try {
    delete lastCasesCache[dateValue];
  } catch (err) {
    console.error("Failed to update cache case history:", err);
  }

  renderCaseHistory();
  if (document.querySelector("#resultBody")) render();
  alert("ลบข้อมูลสำเร็จ");
}

function updateLiffBulkDeleteButton() {
  const btn = document.querySelector("#deleteSelectedLiffButton");
  if (!btn) return;
  const checkedBoxes = document.querySelectorAll("#liffHistoryBody .liff-row-checkbox:checked");
  const count = checkedBoxes.length;
  if (count > 0) {
    btn.textContent = `ลบที่เลือก (${count})`;
    btn.style.display = "inline-block";
  } else {
    btn.style.display = "none";
  }
}

async function deleteSelectedLiffItems() {
  const checkedBoxes = document.querySelectorAll("#liffHistoryBody .liff-row-checkbox:checked");
  if (checkedBoxes.length === 0) return;

  const docIds = Array.from(checkedBoxes).map(cb => cb.dataset.id);
  if (!confirm(`ยืนยันการลบประวัติ LIFF ที่เลือกทั้งหมด ${docIds.length} รายการใช่หรือไม่?`)) return;

  if (db) {
    try {
      const batch = db.batch();
      docIds.forEach(docId => {
        const ref = db.collection("attendance_history").doc(docId);
        batch.delete(ref);
      });
      await batch.commit();
      console.log(`Successfully deleted ${docIds.length} documents from Firestore.`);
    } catch (err) {
      console.error("Firestore batch delete failed:", err);
      alert("ลบข้อมูลจาก Firebase ล้มเหลว: " + err.message);
      return;
    }
  }

  try {
    const filterPairs = docIds.map(docId => {
      const [lineUserId, cycleDate] = docId.includes("_") ? docId.split("_") : [null, null];
      return { id: docId, lineUserId, cycleDate };
    });

    liffHistoryCache = liffHistoryCache.filter(item => {
      return !filterPairs.some(filter => {
        if (item.id === filter.id) return true;
        if (filter.lineUserId && item.lineUserId === filter.lineUserId && (item.cycleDate || item.workDate) === filter.cycleDate) return true;
        return false;
      });
    });
  } catch (err) {
    console.error("Failed to update cache history:", err);
  }

  renderLiffHistory();
  if (document.querySelector("#resultBody")) render();
  alert("ลบข้อมูลสำเร็จ");
}

function updateCaseBulkDeleteButton() {
  const btn = document.querySelector("#deleteSelectedCaseButton");
  if (!btn) return;
  const checkedBoxes = document.querySelectorAll("#caseHistoryBody .case-row-checkbox:checked");
  const count = checkedBoxes.length;
  if (count > 0) {
    btn.textContent = `ลบที่เลือก (${count})`;
    btn.style.display = "inline-block";
  } else {
    btn.style.display = "none";
  }
}

async function deleteSelectedCaseItems() {
  const checkedBoxes = document.querySelectorAll("#caseHistoryBody .case-row-checkbox:checked");
  if (checkedBoxes.length === 0) return;

  const dateValues = Array.from(checkedBoxes).map(cb => cb.dataset.id);
  if (!confirm(`ยืนยันการลบประวัติเคสที่เลือกทั้งหมด ${dateValues.length} รายการใช่หรือไม่?`)) return;

  if (db) {
    try {
      const batch = db.batch();
      dateValues.forEach(dateVal => {
        const ref = db.collection("last_cases").doc(dateVal);
        batch.delete(ref);
      });
      await batch.commit();
      console.log(`Successfully deleted ${dateValues.length} last cases from Firestore.`);
    } catch (err) {
      console.error("Firestore batch delete failed:", err);
      alert("ลบข้อมูลจาก Firebase ล้มเหลว: " + err.message);
      return;
    }
  }

  try {
    dateValues.forEach(dateVal => {
      delete lastCasesCache[dateVal];
    });
  } catch (err) {
    console.error("Failed to update cache case history:", err);
  }

  renderCaseHistory();
  if (document.querySelector("#resultBody")) render();
  alert("ลบข้อมูลสำเร็จ");
}

// ── Pagination helper ──
function buildPaginationBar(totalItems, currentPage, pageSize, onPageChange) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  // Build page number buttons (show max 5 around current)
  const pages = [];
  const delta = 2;
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= currentPage - delta && p <= currentPage + delta)) {
      pages.push(p);
    }
  }
  // Insert ellipsis
  const pageButtons = [];
  let prev = null;
  for (const p of pages) {
    if (prev !== null && p - prev > 1) {
      pageButtons.push(`<span class="pagination-ellipsis">…</span>`);
    }
    pageButtons.push(
      `<button class="pagination-btn${p === currentPage ? ' active' : ''}" data-page="${p}">${p}</button>`
    );
    prev = p;
  }

  const bar = document.createElement("div");
  bar.className = "pagination-bar";
  bar.innerHTML = `
    <span class="pagination-info">แสดง ${totalItems === 0 ? 0 : start}–${end} จาก ${totalItems} รายการ</span>
    <div class="pagination-controls">
      <button class="pagination-btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>‹ ก่อนหน้า</button>
      ${pageButtons.join('')}
      <button class="pagination-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>ถัดไป ›</button>
    </div>
  `;
  bar.querySelectorAll(".pagination-btn[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = Number(btn.dataset.page);
      if (!isNaN(p) && p >= 1 && p <= totalPages) onPageChange(p);
    });
  });
  return bar;
}

function renderLiffHistory() {
  const body = document.querySelector("#liffHistoryBody");
  if (!body) return;

  const history = loadLiffHistory();

  // Populate month filter dropdown dynamically
  const monthFilter = document.querySelector("#liffMonthFilter");
  const dayFilter = document.querySelector("#liffDayFilter");
  const uniqueMonths = Array.from(new Set(history.map(item => item.workDate ? item.workDate.slice(0, 7) : "")))
    .filter(Boolean)
    .sort()
    .reverse();
  updateFilterOptions(monthFilter, uniqueMonths);

  // Populate day filter dropdown dynamically
  const uniqueDays = Array.from(new Set(history.map(item => item.workDate)))
    .filter(Boolean)
    .sort()
    .reverse();
  const currentMonth = monthFilter ? monthFilter.value : "";
  const filteredDays = currentMonth
    ? uniqueDays.filter(d => d.slice(0, 7) === currentMonth)
    : uniqueDays;
  if (dayFilter) {
    const currentDayVal = dayFilter.value;
    const dayOptions = `<option value="">ทั้งหมด</option>` +
      filteredDays.map(d => `<option value="${d}">${parseInt(d.slice(8, 10), 10)}</option>`).join("");
    if (dayFilter.innerHTML !== dayOptions) {
      dayFilter.innerHTML = dayOptions;
      if (Array.from(dayFilter.options).some(opt => opt.value === currentDayVal)) {
        dayFilter.value = currentDayVal;
      } else {
        dayFilter.value = "";
      }
    }
  }

  // Apply month filtering
  const selectedYm = monthFilter ? monthFilter.value : "";
  let filtered = selectedYm ? history.filter(item => item.workDate && item.workDate.slice(0, 7) === selectedYm) : history;

  // Apply day filtering
  const selectedDay = dayFilter ? dayFilter.value : "";
  if (selectedDay) {
    filtered = filtered.filter(item => item.workDate === selectedDay);
  }

  // Apply name search filtering
  const nameSearchEl = document.querySelector("#liffNameSearch");
  const nameQuery = nameSearchEl ? nameSearchEl.value.trim().toLowerCase() : "";
  if (nameQuery) {
    filtered = filtered.filter(item => {
      const name = (item.fullName || item.nickname || "").toLowerCase();
      return name.includes(nameQuery);
    });
  }

  // Remove existing pagination bar if any
  const existingLiffPagination = document.querySelector("#liffPaginationBar");
  if (existingLiffPagination) existingLiffPagination.remove();

  // Reset header checkbox and hide bulk button
  const selectAllCheckbox = document.querySelector("#selectAllLiff");
  if (selectAllCheckbox) selectAllCheckbox.checked = false;
  updateLiffBulkDeleteButton();

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="10" class="empty-state">${selectedYm ? "ไม่มีประวัติในเดือนที่เลือก" : "ยังไม่มีประวัติจาก LIFF"}</td></tr>`;
    return;
  }

  // Pagination — reset to page 1 when filters change
  const totalFiltered = filtered.length;
  if (liffCurrentPage > Math.ceil(totalFiltered / PAGE_SIZE)) liffCurrentPage = 1;
  const pageItems = filtered.slice((liffCurrentPage - 1) * PAGE_SIZE, liffCurrentPage * PAGE_SIZE);

  body.innerHTML = pageItems
    .map(
      (item) => {
        const docId = item.id || `${item.lineUserId}_${item.cycleDate || item.workDate}`;
        const otNoteText = item.workStatus === "work" && item.employeeOtIntent && item.otNote
          ? escapeHtml(item.otNote)
          : "-";
        return `
        <tr>
          <td style="text-align: center; vertical-align: middle;"><input type="checkbox" class="liff-row-checkbox" data-id="${escapeHtml(docId)}" style="width: 18px; min-height: 18px; cursor: pointer; accent-color: var(--rose);" /></td>
          <td>${escapeHtml(formatDisplayDate(item.workDate))}</td>
          <td><strong>${escapeHtml(item.fullName || item.nickname || "-")}</strong></td>
          <td>${escapeHtml(item.department || "-")}</td>
          <td>${escapeHtml(item.workStatusLabel || item.workStatus || "-")}</td>
          <td>${item.plannedStartTime ? `${item.plannedStartTime} / ${item.plannedEndTime}` : "-"}</td>
          <td>${item.workStatus === "work" ? item.employeeOtIntent ? "มี OT" : "ไม่มี OT / ยังไม่ตอบ" : "-"}</td>
          <td>${otNoteText}</td>
          <td>${escapeHtml(formatDateTime(item.otAnsweredAt || item.submittedAt))}</td>
          <td>
            <button class="mini-action danger-action" type="button" data-delete-liff-key="${escapeHtml(docId)}">ลบ</button>
          </td>
        </tr>
      `;
      }
    )
    .join("");

  for (const button of body.querySelectorAll("[data-delete-liff-key]")) {
    button.addEventListener("click", () => {
      deleteLiffHistoryItem(button.dataset.deleteLiffKey);
    });
  }

  const rowCheckboxes = body.querySelectorAll(".liff-row-checkbox");
  for (const cb of rowCheckboxes) {
    cb.addEventListener("change", () => {
      updateLiffBulkDeleteButton();
      if (selectAllCheckbox) {
        selectAllCheckbox.checked = Array.from(rowCheckboxes).every(r => r.checked);
      }
    });
  }

  if (selectAllCheckbox) {
    selectAllCheckbox.onchange = (e) => {
      const checked = e.target.checked;
      for (const cb of rowCheckboxes) {
        cb.checked = checked;
      }
      updateLiffBulkDeleteButton();
    };
  }

  // Render pagination bar below the table-wrap
  const tableWrap = body.closest(".table-wrap");
  if (tableWrap) {
    const paginationBar = buildPaginationBar(totalFiltered, liffCurrentPage, PAGE_SIZE, (p) => {
      liffCurrentPage = p;
      renderLiffHistory();
    });
    paginationBar.id = "liffPaginationBar";
    tableWrap.after(paginationBar);
  }
}

function renderCaseHistory() {
  const body = document.querySelector("#caseHistoryBody");
  if (!body) return;

  const saved = loadCaseSetting();
  const byDate = saved.byDate || {};
  const items = Object.entries(byDate)
    .map(([date, setting]) => ({ date, ...setting }))
    .sort((a, b) => b.date.localeCompare(a.date));

  // Populate month filter dropdown dynamically
  const monthFilter = document.querySelector("#caseMonthFilter");
  const dayFilter = document.querySelector("#caseDayFilter");
  const uniqueMonths = Array.from(new Set(items.map(item => item.date ? item.date.slice(0, 7) : "")))
    .filter(Boolean)
    .sort()
    .reverse();
  updateFilterOptions(monthFilter, uniqueMonths);

  // Populate day filter dropdown dynamically
  const uniqueDays = Array.from(new Set(items.map(item => item.date)))
    .filter(Boolean)
    .sort()
    .reverse();
  const currentMonth = monthFilter ? monthFilter.value : "";
  const filteredDays = currentMonth
    ? uniqueDays.filter(d => d.slice(0, 7) === currentMonth)
    : uniqueDays;
  if (dayFilter) {
    const currentDayVal = dayFilter.value;
    const dayOptions = `<option value="">ทั้งหมด</option>` +
      filteredDays.map(d => `<option value="${d}">${parseInt(d.slice(8, 10), 10)}</option>`).join("");
    if (dayFilter.innerHTML !== dayOptions) {
      dayFilter.innerHTML = dayOptions;
      if (Array.from(dayFilter.options).some(opt => opt.value === currentDayVal)) {
        dayFilter.value = currentDayVal;
      } else {
        dayFilter.value = "";
      }
    }
  }

  // Apply month filtering
  const selectedYm = monthFilter ? monthFilter.value : "";
  let filtered = selectedYm ? items.filter(item => item.date && item.date.slice(0, 7) === selectedYm) : items;

  // Apply day filtering
  const selectedDay = dayFilter ? dayFilter.value : "";
  if (selectedDay) {
    filtered = filtered.filter(item => item.date === selectedDay);
  }

  // Remove existing pagination bar if any
  const existingCasePagination = document.querySelector("#casePaginationBar");
  if (existingCasePagination) existingCasePagination.remove();

  // Reset header checkbox and hide bulk button
  const selectAllCheckbox = document.querySelector("#selectAllCase");
  if (selectAllCheckbox) selectAllCheckbox.checked = false;
  updateCaseBulkDeleteButton();

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty-state">${selectedYm ? "ไม่มีประวัติเคสในเดือนที่เลือก" : "ยังไม่มีประวัติเคสสุดท้าย"}</td></tr>`;
    return;
  }

  // Pagination — reset to page 1 when filters change
  const totalFiltered = filtered.length;
  if (caseCurrentPage > Math.ceil(totalFiltered / PAGE_SIZE)) caseCurrentPage = 1;
  const pageItems = filtered.slice((caseCurrentPage - 1) * PAGE_SIZE, caseCurrentPage * PAGE_SIZE);

  body.innerHTML = pageItems
    .map(
      (item) => `
        <tr>
          <td style="text-align: center; vertical-align: middle;"><input type="checkbox" class="case-row-checkbox" data-id="${escapeHtml(item.date)}" style="width: 18px; min-height: 18px; cursor: pointer; accent-color: var(--rose);" /></td>
          <td>${escapeHtml(formatDisplayDate(item.date))}</td>
          <td><strong>${escapeHtml(item.task || "-")}</strong></td>
          <td>${escapeHtml(`${item.hour || "--"}:${item.minute || "--"}`)}</td>
          <td>${escapeHtml(item.note || "-")}</td>
          <td>
            <button class="mini-action danger-action" type="button" data-delete-case-key="${escapeHtml(item.date)}">ลบ</button>
          </td>
        </tr>
      `,
    )
    .join("");

  for (const button of body.querySelectorAll("[data-delete-case-key]")) {
    button.addEventListener("click", () => {
      deleteCaseHistoryItem(button.dataset.deleteCaseKey);
    });
  }

  const rowCheckboxes = body.querySelectorAll(".case-row-checkbox");
  for (const cb of rowCheckboxes) {
    cb.addEventListener("change", () => {
      updateCaseBulkDeleteButton();
      if (selectAllCheckbox) {
        selectAllCheckbox.checked = Array.from(rowCheckboxes).every(r => r.checked);
      }
    });
  }

  if (selectAllCheckbox) {
    selectAllCheckbox.onchange = (e) => {
      const checked = e.target.checked;
      for (const cb of rowCheckboxes) {
        cb.checked = checked;
      }
      updateCaseBulkDeleteButton();
    };
  }

  // Render pagination bar below the table-wrap
  const tableWrap = body.closest(".table-wrap");
  if (tableWrap) {
    const paginationBar = buildPaginationBar(totalFiltered, caseCurrentPage, PAGE_SIZE, (p) => {
      caseCurrentPage = p;
      renderCaseHistory();
    });
    paginationBar.id = "casePaginationBar";
    tableWrap.after(paginationBar);
  }
}

async function handleFile(file) {
  const message = document.querySelector("#importMessage");
  if (!file) return;
  const fileName = String(file.name || "");
  const lowerFileName = fileName.toLowerCase();

  if (lowerFileName.endsWith(".lnk")) {
    message.textContent = "ไฟล์ .lnk เป็น Shortcut จาก Recent กรุณาเลือกไฟล์ Excel ตัวจริงที่ลงท้าย .xlsx หรือ .xls";
    return;
  }

  if (!/\.(xlsx|xls|csv)$/i.test(fileName)) {
    message.textContent = "รองรับเฉพาะไฟล์ .xlsx, .xls หรือ .csv";
    return;
  }

  if (!window.XLSX) {
    message.textContent = "ยังโหลดตัวอ่าน Excel ไม่สำเร็จ กรุณาต่ออินเทอร์เน็ตหรือใช้ปุ่มโหลดตัวอย่างก่อน";
    return;
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
  const headerRow = matrix?.[1] || [];
  const isMonthlyScanFile = headerRow.some(c => String(c || "").trim() === "ชื่อบุคคล" || String(c || "").trim() === "ชื่อ");
  const parsedRows = isMonthlyScanFile
    ? parseMonthlyScanRows(matrix, file.name)
    : XLSX.utils.sheet_to_json(sheet, { defval: "" }).map(normalizeRecord);
  setRows(parsedRows);
  message.textContent = `นำเข้า ${parsedRows.length} รายการจาก ${file.name}`;
}

async function fetchSettingsFromFirestore() {
  if (!db) {
    rulesCache = defaultRules;
    lateRuleCache = { ratePerMinute: 2, monthlyFreeMinutes: 15 };
    otRuleCache = { minThreshold: 15 };
    lastCasesCache = {};
    userOverridesCache = {};
    return;
  }
  try {
    const rulesDoc = await db.collection("settings").doc("rules").get();
    rulesCache = rulesDoc.exists ? (rulesDoc.data().rules || defaultRules) : defaultRules;

    const lateRuleDoc = await db.collection("settings").doc("late_rule").get();
    lateRuleCache = lateRuleDoc.exists ? lateRuleDoc.data() : { ratePerMinute: 2, monthlyFreeMinutes: 15 };

    const otRuleDoc = await db.collection("settings").doc("ot_rule").get();
    otRuleCache = otRuleDoc.exists ? otRuleDoc.data() : { minThreshold: 15 };

    const lastCasesSnapshot = await db.collection("last_cases").get();
    lastCasesCache = {};
    lastCasesSnapshot.forEach(doc => {
      lastCasesCache[doc.id] = doc.data();
    });

    const userOverridesDoc = await db.collection("settings").doc("user_overrides").get();
    userOverridesCache = userOverridesDoc.exists ? (userOverridesDoc.data().overrides || {}) : {};
  } catch (err) {
    console.error("Failed to fetch settings from Firestore:", err);
    // fallback
    rulesCache = defaultRules;
    lateRuleCache = { ratePerMinute: 2, monthlyFreeMinutes: 15 };
    otRuleCache = { minThreshold: 15 };
    lastCasesCache = {};
    userOverridesCache = {};
  }
}

async function fetchLiffHistoryFromFirestore() {
  if (db) {
    try {
      const snapshot = await db.collection("attendance_history")
        .orderBy("submittedAt", "desc")
        .limit(3000)
        .get();
      liffHistoryCache = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        data.id = doc.id;
        liffHistoryCache.push(data);
      });
      return;
    } catch (err) {
      console.error("Failed to fetch LIFF history from Firestore:", err);
    }
  }
// Fallback
  liffHistoryCache = [];
}

let unsubscribeSettings = null;
let unsubscribeProfiles = null;
let unsubscribeLiffHistory = null;
let unsubscribeLastCases = null;
let unsubscribeSpecialOtAssignments = null;

function listenToSettings() {
  if (!db) return;
  if (unsubscribeSettings) unsubscribeSettings();
  unsubscribeSettings = db.collection("settings").onSnapshot((snapshot) => {
    snapshot.forEach((doc) => {
      if (doc.id === "rules") {
        rulesCache = doc.data().rules || defaultRules;
        renderRules();
      } else if (doc.id === "late_rule") {
        lateRuleCache = doc.data();
        applyLateRule();
      } else if (doc.id === "ot_rule") {
        otRuleCache = doc.data() || { minThreshold: 15 };
        applyOtRule();
      } else if (doc.id === "user_overrides") {
        userOverridesCache = doc.data().overrides || {};
        renderUsersPage();
      }
    });
    console.log("Settings updated in real-time.");
    if (document.querySelector("#resultBody")) render();
  }, (err) => console.error("Failed to subscribe to settings:", err));
}

function listenToProfiles() {
  if (!db) return;
  if (unsubscribeProfiles) unsubscribeProfiles();
  unsubscribeProfiles = db.collection("profiles").onSnapshot((snapshot) => {
    profilesCache = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.status === "registered" || data.fullName || data.firstName) {
        profilesCache.push({
          id: data.employeeId || doc.id,
          fullName: data.fullName || data.staffDirectoryFullName || (data.firstName + " " + data.lastName),
          nickname: data.nickname || "",
          department: data.department || "",
          position: data.position || data.department || "",
          lineUserId: data.lineUserId || "",
          lineDisplayName: data.lineDisplayName || "",
        });
      }
    });
    console.log("Profiles updated in real-time:", profilesCache.length);
    renderUsersPage();
    renderSpecialOtEmployeeOptions();
    if (document.querySelector("#resultBody")) render();
  }, (err) => console.error("Failed to subscribe to profiles:", err));
}

function listenToSpecialOtAssignments() {
  if (!db) return;
  if (unsubscribeSpecialOtAssignments) unsubscribeSpecialOtAssignments();
  unsubscribeSpecialOtAssignments = db.collection("special_ot_assignments")
    .orderBy("createdAt", "desc")
    .limit(500)
    .onSnapshot((snapshot) => {
      specialOtAssignmentsCache = [];
      snapshot.forEach((doc) => {
        specialOtAssignmentsCache.push({ id: doc.id, ...doc.data() });
      });
      persistSpecialOtAssignmentsLocally();
      renderSpecialOtAssignments();
      if (document.querySelector("#resultBody")) render();
      console.log("Special OT assignments updated in real-time:", specialOtAssignmentsCache.length);
    }, (err) => console.error("Failed to subscribe to special OT assignments:", err));
}

function listenToLiffHistory() {
  if (!db) return;
  if (unsubscribeLiffHistory) unsubscribeLiffHistory();
  unsubscribeLiffHistory = db.collection("attendance_history")
    .orderBy("submittedAt", "desc")
    .limit(3000)
    .onSnapshot((snapshot) => {
      liffHistoryCache = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        data.id = doc.id;
        liffHistoryCache.push(data);
      });
      console.log("LIFF history updated in real-time:", liffHistoryCache.length);
      renderLiffHistory();
      if (document.querySelector("#resultBody")) render();
    }, (err) => console.error("Failed to subscribe to LIFF history:", err));
}

function listenToLastCases() {
  if (!db) return;
  if (unsubscribeLastCases) unsubscribeLastCases();
  unsubscribeLastCases = db.collection("last_cases").onSnapshot((snapshot) => {
    lastCasesCache = {};
    snapshot.forEach((doc) => {
      lastCasesCache[doc.id] = doc.data();
    });
    console.log("Last cases updated in real-time:", Object.keys(lastCasesCache).length);
    applyCaseSetting(loadCaseSettingForDate(), getActiveWorkDate());
    renderCaseHistory();
    if (document.querySelector("#resultBody")) render();
  }, (err) => console.error("Failed to subscribe to last cases:", err));
}


async function init() {
  // Initialize caches with defaults directly (instant load & fallbacks)
  rulesCache = defaultRules;
  lateRuleCache = { ratePerMinute: 2, monthlyFreeMinutes: 15 };
  otRuleCache = { minThreshold: 15 };
  lastCasesCache = {};
  userOverridesCache = {};
  profilesCache = [];
  liffHistoryCache = [];
  specialOtAssignmentsCache = loadSpecialOtAssignmentsFromLocal();

  if (document.querySelector("#caseDate")) {
    document.querySelector("#caseDate").value = formatDisplayDate(todayInputValue());
  }
  if (document.querySelector("#caseDateNative")) {
    document.querySelector("#caseDateNative").value = todayInputValue();
  }
  applyCaseSetting(loadCaseSettingForDate(), getActiveWorkDate());
  
  // Render initially with the loaded fallbacks/caches
  if (document.querySelector("#liffHistoryBody")) {
    renderHistoryPage();
  }
  renderRules();
  applyLateRule();
  applyOtRule();
  renderLiffHistory();
  renderCaseHistory();
  renderUsersPage();
  renderSpecialOtEmployeeOptions();
  renderSpecialOtAssignments();

  const specialOtWorkDate = document.querySelector("#specialOtWorkDate");
  const specialOtEndDate = document.querySelector("#specialOtEndDate");
  if (specialOtWorkDate) specialOtWorkDate.value = todayInputValue();
  if (specialOtEndDate) specialOtEndDate.value = getNextCalendarDateValue(todayInputValue());

  // If Firebase is available, register real-time snapshot listeners to override caches and re-render
  if (db) {
    listenToSettings();
    listenToProfiles();
    listenToLiffHistory();
    listenToLastCases();
    listenToSpecialOtAssignments();
  }

  document.querySelector("#loadSampleButton")?.addEventListener("click", () => {
    setRows(sampleRows);
    document.querySelector("#importMessage").textContent = "โหลดข้อมูลตัวอย่างแล้ว";
  });

  document.querySelector("#calculateButton")?.addEventListener("click", render);
  document.querySelector("#newRuleButton")?.addEventListener("click", clearRuleForm);
  document.querySelector("#saveRuleButton")?.addEventListener("click", saveRuleFromForm);
  document.querySelector("#saveLateRuleButton")?.addEventListener("click", saveLateRuleFromForm);
  document.querySelector("#saveOtRuleButton")?.addEventListener("click", saveOtRuleFromForm);
  document.querySelector("#saveCaseButton")?.addEventListener("click", saveCaseFromForm);
  document.querySelector("#saveSpecialOtButton")?.addEventListener("click", saveSpecialOtAssignment);
  document.querySelector("#resetRulesButton")?.addEventListener("click", async () => {
    await saveRules(defaultRules);
    renderRules();
    if (document.querySelector("#resultBody")) render();
  });
  document.querySelector("#deleteSelectedLiffButton")?.addEventListener("click", deleteSelectedLiffItems);
  document.querySelector("#deleteSelectedCaseButton")?.addEventListener("click", deleteSelectedCaseItems);

  document.querySelector("#clearLiffHistoryButton")?.addEventListener("click", async () => {
    liffHistoryCache = [];
    if (db) {
      try {
        const snapshot = await db.collection("attendance_history").get();
        const batch = db.batch();
        snapshot.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log("Firestore history cleared.");
      } catch (err) {
        console.error("Failed to clear Firestore history:", err);
      }
    }
    renderLiffHistory();
  });
  document.querySelector("#clearCaseHistoryButton")?.addEventListener("click", async () => {
    lastCasesCache = {};
    if (db) {
      try {
        const snapshot = await db.collection("last_cases").get();
        const batch = db.batch();
        snapshot.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log("Firestore case history cleared.");
      } catch (err) {
        console.error("Failed to clear Firestore case history:", err);
      }
    }
    renderCaseHistory();
  });
  document.querySelector("#fileInput")?.addEventListener("change", (event) => {
    handleFile(event.target.files[0]);
  });

  document.querySelector("#specialOtEmployeeSearch")?.addEventListener("input", renderSpecialOtEmployeeOptions);
  document.querySelector("#selectAllSpecialOtEmployees")?.addEventListener("click", () => {
    getFilteredSelectableSpecialOtEmployees().forEach((employee) => specialOtSelectedEmployeeKeys.add(employee.key));
    renderSpecialOtEmployeeOptions();
  });
  document.querySelector("#clearSpecialOtEmployees")?.addEventListener("click", () => {
    specialOtSelectedEmployeeKeys.clear();
    renderSpecialOtEmployeeOptions();
  });
  document.querySelector("#specialOtWorkDate")?.addEventListener("change", (event) => {
    const endDate = document.querySelector("#specialOtEndDate");
    if (endDate) endDate.value = getNextCalendarDateValue(event.target.value);
  });

  for (const id of ["lastCaseHour", "lastCaseMinute"]) {
    document.querySelector(`#${id}`)?.addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 2);
      renderCaseSummary();
    });
  }

  for (const id of ["ruleFlatRate", "ruleNightRate"]) {
    document.querySelector(`#${id}`)?.addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 5);
    });
  }

  document.querySelector("#ruleBufferHours")?.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 2);
  });

  for (const id of ["lateRatePerMinute", "lateMonthlyFreeMinutes", "otMinThreshold"]) {
    document.querySelector(`#${id}`)?.addEventListener("input", (event) => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 5);
    });
  }

  for (const id of ["lastCaseTask", "lastCaseNote"]) {
    document.querySelector(`#${id}`)?.addEventListener("input", renderCaseSummary);
  }

  document.querySelector("#caseDate")?.addEventListener("click", openCaseDatePicker);
  document.querySelector("#openCaseDatePicker")?.addEventListener("click", openCaseDatePicker);

  document.querySelector("#caseDateNative")?.addEventListener("change", (event) => {
    const selectedDate = normalizeDate(event.target.value);
    document.querySelector("#caseDate").value = formatDisplayDate(selectedDate);
    applyCaseSetting(loadCaseSettingForDate(selectedDate), selectedDate);
  });

  document.querySelector("#liffDayFilter")?.addEventListener("change", () => {
    liffCurrentPage = 1;
    renderLiffHistory();
  });
  document.querySelector("#liffMonthFilter")?.addEventListener("change", () => {
    // Reset day filter and page when month changes
    const daySelect = document.querySelector("#liffDayFilter");
    if (daySelect) daySelect.value = "";
    liffCurrentPage = 1;
    renderLiffHistory();
  });

  document.querySelector("#caseDayFilter")?.addEventListener("change", () => {
    caseCurrentPage = 1;
    renderCaseHistory();
  });
  document.querySelector("#caseMonthFilter")?.addEventListener("change", () => {
    // Reset day filter and page when month changes
    const daySelect = document.querySelector("#caseDayFilter");
    if (daySelect) daySelect.value = "";
    caseCurrentPage = 1;
    renderCaseHistory();
  });

  // Name search listeners
  document.querySelector("#liffNameSearch")?.addEventListener("input", () => {
    liffCurrentPage = 1;
    renderLiffHistory();
  });
  document.querySelector("#usersNameSearch")?.addEventListener("input", () => {
    renderUsersPage();
  });
}

init();
