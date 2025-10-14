const categories = ["water", "electric", "internet"];
const expenseFields = [...categories];
const baseDocumentTitle = document.title;

const appState = {
  workspace: {
    name: "",
  },
  users: [],
  expenses: {
    water: 0,
    electric: 0,
    internet: 0,
    rent: 0,
  },
  totals: {
    water: 0,
    electric: 0,
    internet: 0,
    rent: 0,
    abono_general: 0,
    abono_mineral: 0,
    grand: 0,
  },
  period: {
    start: "",
    end: "",
    total_days: 0,
    total_occupancy_days: 0,
  },
  fixed: [],
  meta: {
    total_residents: 0,
    fixed_totals: {
      water: 0,
      electric: 0,
      internet: 0,
    },
  },
};

const superState = {
  tenants: [],
  admins: [],
  residents: [],
  feedbacks: [],
  stats: {
    tenant_count: 0,
    admin_count: 0,
    resident_count: 0,
    feedback_count: 0,
  },
};

const resetSuperState = () => {
  superState.tenants = [];
  superState.admins = [];
  superState.residents = [];
  superState.feedbacks = [];
  superState.stats = {
    tenant_count: 0,
    admin_count: 0,
    resident_count: 0,
    feedback_count: 0,
  };
  openSuperDetails.clear();
  currentSuperTab = "overview";
};

const sessionState = {
  authenticated: false,
  account: null,
  inviteToken: null,
  workspaceName: "",
  csrfToken: null,
};

let selectedAwayUserId = null;
let selectedAbonoUserId = null;
const openDetails = new Set();
let workspaceFeedbackTimeoutId = null;
const openSuperDetails = new Set();
let currentSuperTab = "overview";
const feedbackState = {
  open: false,
  busy: false,
};

const getUserById = (id) =>
  appState.users.find((user) => user.id === id) || null;

const formatCurrency = (value) =>
  new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
  }).format(value ?? 0);

const formatDateTime = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatRoleLabel = (role) => {
  if (!role) {
    return "";
  }
  if (role === "superadmin") {
    return "Super admin";
  }
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
};

const normaliseCurrency = (value) => (Math.abs(value ?? 0) < 0.005 ? 0 : value ?? 0);

const pluralise = (value, label) =>
  `${value} ${label}${value === 1 ? "" : "s"}`;

const buildDaysNote = (daysPresent, totalDays, daysOut) => {
  if (!Number.isFinite(daysPresent) || !Number.isFinite(totalDays) || totalDays <= 0) {
    return "";
  }
  const awayDays =
    Number.isFinite(daysOut) && daysOut >= 0 ? daysOut : Math.max(totalDays - daysPresent, 0);
  const awayText = awayDays > 0 ? `, away ${pluralise(awayDays, "day")}` : "";
  return `${pluralise(daysPresent, "day")} billed out of ${pluralise(totalDays, "day")}${awayText}`;
};

const buildShareNote = (detail) => {
  if (!detail) {
    return "";
  }
  const residentCount = Number(detail.resident_count ?? 0);
  const fixedTotal = normaliseCurrency(detail.fixed_total ?? 0);
  const fixedPortion = normaliseCurrency(detail.fixed_portion ?? 0);

  let fixedPart = `Fixed ${formatCurrency(fixedTotal)}`;
  if (residentCount > 0) {
    fixedPart += ` ÷ ${pluralise(residentCount, "resident")} = ${formatCurrency(fixedPortion)}`;
  } else {
    fixedPart += ` = ${formatCurrency(fixedPortion)}`;
  }

  const totalDays = Number(detail.total_days ?? 0);
  const daysCharged = Number(detail.days_charged ?? 0);
  const variablePool = normaliseCurrency(detail.variable_pool ?? 0);
  const perDayRate = normaliseCurrency(detail.per_day_rate ?? 0);
  const variablePortion = normaliseCurrency(detail.variable_portion ?? 0);

  let variablePart;
  if (totalDays > 0 && daysCharged > 0 && variablePool > 0) {
    variablePart = `Variable (${formatCurrency(variablePool)} ÷ ${pluralise(
      totalDays,
      "day"
    )} = ${formatCurrency(perDayRate)} per day) × ${pluralise(
      daysCharged,
      "day"
    )} = ${formatCurrency(variablePortion)}`;
  } else if (variablePool > 0 && totalDays > 0) {
    variablePart = `Variable ${formatCurrency(variablePool)} ÷ ${pluralise(
      totalDays,
      "day"
    )} = ${formatCurrency(perDayRate)} per day`;
  } else {
    variablePart = `Variable ${formatCurrency(variablePortion)}`;
  }

  const amount = normaliseCurrency(detail.amount ?? 0);
  return `${fixedPart}; ${variablePart}; Total ${formatCurrency(amount)}`;
};

const buildRentNote = (detail) => {
  if (!detail) {
    return "";
  }
  const totalRent = normaliseCurrency(detail.total_rent ?? 0);
  const residentCount = Number(detail.resident_count ?? 0);
  const share = normaliseCurrency(detail.share ?? 0);
  if (residentCount > 0) {
    return `${formatCurrency(totalRent)} ÷ ${pluralise(residentCount, "resident")} = ${formatCurrency(share)}`;
  }
  return `Total rent ${formatCurrency(totalRent)}`;
};

const buildUtilitiesNote = (share) => {
  if (!share) {
    return "";
  }
  const water = normaliseCurrency(share.water ?? 0);
  const electric = normaliseCurrency(share.electric ?? 0);
  const internet = normaliseCurrency(share.internet ?? 0);
  const total = normaliseCurrency(share.total ?? water + electric + internet);
  return `${formatCurrency(water)} water + ${formatCurrency(electric)} electric + ${formatCurrency(
    internet
  )} internet = ${formatCurrency(total)}`;
};

const buildAmountNote = (utilities, rent, generalCredit, mineralCredit, netTotal) => {
  const utilitiesValue = normaliseCurrency(utilities);
  const rentValue = normaliseCurrency(rent);
  const generalValue = normaliseCurrency(generalCredit);
  const mineralValue = normaliseCurrency(mineralCredit);
  const netValue = normaliseCurrency(netTotal);

  return `Utilities ${formatCurrency(utilitiesValue)} + Rent ${formatCurrency(
    rentValue
  )} - Abono ${formatCurrency(generalValue)} - Mineral ${formatCurrency(mineralValue)} = ${formatCurrency(
    netValue
  )}`;
};

const renderReceiptList = (
  container,
  receipts,
  emptyMessage = "No receipts uploaded yet.",
  options = {}
) => {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  if (!receipts || receipts.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.textContent = emptyMessage;
    emptyItem.style.opacity = "0.7";
    container.appendChild(emptyItem);
    return;
  }

  receipts.forEach((receipt) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = receipt.url;
    link.textContent = receipt.original_name;
    link.target = "_blank";
    link.rel = "noopener";

    const timestamp = document.createElement("time");
    const uploaded = receipt.uploaded_at ? new Date(receipt.uploaded_at) : null;
    timestamp.dateTime = uploaded ? uploaded.toISOString() : "";
    timestamp.textContent = uploaded ? uploaded.toLocaleString() : "";

    item.append(link, timestamp);

    if (options.showDelete) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "danger receipt-delete";
      deleteBtn.textContent = "Delete";
      deleteBtn.dataset.receiptId = String(receipt.id);
      item.appendChild(deleteBtn);
    }

    container.appendChild(item);
  });
};

const elements = {
  appRoot: document.getElementById("app-root"),
  header: {
    title: document.getElementById("app-title"),
    workspaceName: document.getElementById("workspace-name"),
  },
  auth: {
    screen: document.getElementById("auth-screen"),
    message: document.getElementById("auth-message"),
    menu: document.getElementById("auth-menu"),
    menuButtons: Array.from(document.querySelectorAll(".auth-menu-btn")),
    backButtons: Array.from(document.querySelectorAll(".auth-back")),
    forms: {
      loginAdmin: document.getElementById("login-admin-form"),
      loginRenter: document.getElementById("login-renter-form"),
      registerAdmin: document.getElementById("register-admin-form"),
      registerRenter: document.getElementById("register-renter-form"),
    },
    inputs: {
      renterToken: document.getElementById("register-renter-token"),
      renterUsername: document.getElementById("register-renter-username"),
      renterPassword: document.getElementById("register-renter-password"),
      loginAdminDormName: document.getElementById("login-admin-dorm-name"),
      loginAdminUsername: document.getElementById("login-admin-username"),
      loginAdminPassword: document.getElementById("login-admin-password"),
      loginRenterDormName: document.getElementById("login-renter-dorm-name"),
      loginRenterUsername: document.getElementById("login-renter-username"),
      loginRenterPassword: document.getElementById("login-renter-password"),
      registerAdminUsername: document.getElementById("register-admin-username"),
      registerAdminPassword: document.getElementById("register-admin-password"),
      registerAdminDormName: document.getElementById("register-admin-dorm-name"),
    },
    overlay: {
      container: document.getElementById("invite-overlay"),
      link: document.getElementById("invite-overlay-link"),
      copyBtn: document.getElementById("invite-overlay-copy"),
      continueBtn: document.getElementById("invite-overlay-continue"),
      feedback: document.getElementById("invite-overlay-feedback"),
    },
  },
  userBar: {
    container: document.getElementById("user-bar"),
    info: document.getElementById("user-info"),
    logout: document.getElementById("logout-btn"),
  },
  superAdmin: {
    root: document.getElementById("super-admin-root"),
    userBar: document.getElementById("super-user-bar"),
    userInfo: document.getElementById("super-user-info"),
    stats: {
      tenants: document.getElementById("super-total-tenants"),
      admins: document.getElementById("super-total-admins"),
      residents: document.getElementById("super-total-residents"),
    },
    tableBody: document.getElementById("super-tenant-body"),
    feedbackBody: document.getElementById("super-feedback-body"),
    feedbackEmpty: document.getElementById("super-feedback-empty"),
    tabs: {
      container: document.querySelector("#super-admin-root .super-tabs"),
      overview: document.getElementById("super-tab-overview"),
      feedbacks: document.getElementById("super-tab-feedbacks"),
    },
    panels: {
      overview: document.getElementById("super-overview-panel"),
      feedbacks: document.getElementById("super-feedback-panel"),
    },
    logout: document.getElementById("super-logout-btn"),
  },
  form: document.getElementById("add-user-form"),
  adminForm: document.getElementById("admin-form"),
  tbody: document.getElementById("user-table-body"),
  rowTemplate: document.getElementById("user-row-template"),
  detailTemplate: document.getElementById("user-detail-template"),
  billingPeriod: document.getElementById("billing-period"),
  totals: {
    water: document.getElementById("total-water"),
    electric: document.getElementById("total-electric"),
    internet: document.getElementById("total-internet"),
    rent: document.getElementById("total-rent"),
    abonoGeneral: document.getElementById("total-abono-general"),
    abonoMineral: document.getElementById("total-abono-mineral"),
    grand: document.getElementById("grand-total"),
  },
  tabButtons: Array.from(document.querySelectorAll("#app-root .tabs .tab-button")),
  tabPanels: Array.from(document.querySelectorAll("#app-root .tab-panel")),
  feedbackWidget: {
    toggle: document.getElementById("feedback-toggle"),
    panel: document.getElementById("feedback-panel"),
    form: document.getElementById("feedback-form"),
    messageInput: document.getElementById("feedback-message"),
    contactInput: document.getElementById("feedback-contact"),
    submit: document.getElementById("feedback-submit"),
    status: document.getElementById("feedback-status"),
    counter: document.getElementById("feedback-counter"),
    close: document.getElementById("feedback-close"),
  },
  workspace: {
    form: document.getElementById("workspace-form"),
    nameInput: document.getElementById("workspace-name-input"),
    feedback: document.getElementById("workspace-feedback"),
  },
  adminInvite: {
    card: document.getElementById("admin-invite-card"),
    link: document.getElementById("admin-invite-link"),
    copyBtn: document.getElementById("admin-copy-invite"),
    rotateBtn: document.getElementById("admin-rotate-invite"),
  },
  away: {
    select: document.getElementById("out-user-select"),
    addForm: document.getElementById("add-out-form"),
    startInput: document.getElementById("out-start"),
    endInput: document.getElementById("out-end"),
    tableBody: document.getElementById("out-table-body"),
    emptyMessage: document.getElementById("out-empty"),
  },
  abono: {
    select: document.getElementById("abono-user-select"),
    summaryTotal: document.getElementById("abono-summary-total"),
    summaryCredit: document.getElementById("abono-summary-credit"),
    summaryMineral: document.getElementById("abono-summary-mineral"),
    summaryRent: document.getElementById("abono-summary-rent"),
    summaryDue: document.getElementById("abono-summary-due"),
    creditForm: document.getElementById("abono-credit-form"),
    creditInput: document.getElementById("abono-credit-input"),
    mineralForm: document.getElementById("mineral-credit-form"),
    mineralInput: document.getElementById("mineral-credit-input"),
    receiptList: document.getElementById("abono-receipt-list"),
    receiptEmpty: document.getElementById("abono-receipts-empty"),
    uploadForm: document.getElementById("abono-upload-form"),
    uploadInput: document.getElementById("abono-receipt-file"),
  },
  billing: {
    form: document.getElementById("billing-form"),
    startInput: document.getElementById("billing-start"),
    endInput: document.getElementById("billing-end"),
    currentBtn: document.getElementById("billing-current"),
  },
  checking: {
    utilities: document.getElementById("checking-utilities"),
    rent: document.getElementById("checking-rent"),
    fixed: document.getElementById("checking-fixed"),
    abonoGeneral: document.getElementById("checking-abono-general"),
    abonoMineral: document.getElementById("checking-abono-mineral"),
    grand: document.getElementById("checking-grand"),
    residentTotal: document.getElementById("checking-resident-total"),
    difference: document.getElementById("checking-difference"),
    status: document.getElementById("checking-status"),
    tableBody: document.getElementById("checking-table-body"),
  },
  fixed: {
    form: document.getElementById("fixed-form"),
    nameInput: document.getElementById("fixed-name"),
    categoryInput: document.getElementById("fixed-category"),
    amountInput: document.getElementById("fixed-amount"),
    tableBody: document.getElementById("fixed-table-body"),
    emptyMessage: document.getElementById("fixed-empty"),
  },
};

elements.logoutButtons = Array.from(document.querySelectorAll(".logout-btn"));

const parseAmount = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const safeHttpMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const request = async (url, options = {}) => {
  const { headers = {}, body, method, ...rest } = options;
  const resolvedMethod = (method || "GET").toUpperCase();
  const finalHeaders = { ...headers };

  if (!(body instanceof FormData) && !finalHeaders["Content-Type"]) {
    finalHeaders["Content-Type"] = "application/json";
  }

  if (!safeHttpMethods.has(resolvedMethod) && sessionState.csrfToken) {
    finalHeaders["X-CSRF-Token"] = sessionState.csrfToken;
  }

  const fetchOptions = {
    credentials: "include",
    method: resolvedMethod,
    ...rest,
  };

  if (body !== undefined) {
    fetchOptions.body = body;
  }

  if (Object.keys(finalHeaders).length > 0) {
    fetchOptions.headers = finalHeaders;
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch (error) {
      payload = {};
    }
    const message = payload.message || `Request failed with status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    if (response.status === 401) {
      await refreshSession();
    }
    throw err;
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
};

let currentAuthView = null;
let inviteTokenFromQuery = null;
let inviteHintTimeoutId = null;

const showAuthMessage = (message = "", type = "error") => {
  const messageEl = elements.auth.message;
  if (!messageEl) {
    return;
  }
  if (!message) {
    messageEl.hidden = true;
    messageEl.textContent = "";
    messageEl.classList.remove("success");
    return;
  }
  messageEl.hidden = false;
  messageEl.textContent = message;
  messageEl.classList.toggle("success", type === "success");
};

const resetAuthForms = () => {
  const forms = elements.auth.forms;
  if (!forms) {
    return;
  }
  Object.values(forms).forEach((form) => form?.reset());
};

const setAuthView = (view, options = {}) => {
  const targetView = view || "menu";
  currentAuthView = targetView;
  const forms = elements.auth.forms;
  const menu = elements.auth.menu;

  if (menu) {
    menu.hidden = targetView !== "menu";
  }

  if (!options.keepMessage) {
    showAuthMessage("");
  }

  if (!forms) {
    return;
  }

  Object.values(forms).forEach((form) => {
    if (!form) {
      return;
    }
    const isMatch = form.dataset.view === targetView;
    if (isMatch && !options.preserveValues) {
      form.reset();
    } else if (!isMatch && options.resetHidden) {
      form.reset();
    }
    form.hidden = !isMatch;
    form.classList.toggle("active", isMatch);
    if (isMatch && !options.skipFocus) {
      const input = form.querySelector("input:not([type='hidden']):not([disabled])");
      if (input) {
        input.focus();
        if (typeof input.select === "function") {
          input.select();
        }
      }
    }
  });
};

const buildInviteLink = (token) =>
  `${window.location.origin}${window.location.pathname}?invite=${token}`;

const setInviteFeedback = (message, { target = "auto", error = false } = {}) => {
  const overlay = elements.auth.overlay;
  const overlayFeedback = overlay?.feedback;
  const adminFeedback = document.getElementById("admin-invite-feedback");

  const applyMessage = (element) => {
    if (!element) {
      return false;
    }
    element.textContent = message;
    element.hidden = !message;
    element.classList.toggle("error", error);
    return true;
  };

  if (!message) {
    if (overlayFeedback) {
      overlayFeedback.hidden = true;
      overlayFeedback.classList.remove("error");
    }
    if (adminFeedback) {
      adminFeedback.hidden = true;
      adminFeedback.classList.remove("error");
    }
    if (inviteHintTimeoutId) {
      clearTimeout(inviteHintTimeoutId);
      inviteHintTimeoutId = null;
    }
    return;
  }

  let handled = false;
  if (target === "overlay" || (target === "auto" && overlay && overlay.container && !overlay.container.hidden)) {
    handled = applyMessage(overlayFeedback);
  }
  if (!handled && (target === "admin" || target === "auto")) {
    handled = applyMessage(adminFeedback);
  }

  if (!handled && target === "overlay") {
    applyMessage(overlayFeedback);
  }

  if (!handled && target === "admin") {
    applyMessage(adminFeedback);
  }

  if (inviteHintTimeoutId) {
    clearTimeout(inviteHintTimeoutId);
  }
  inviteHintTimeoutId = setTimeout(() => {
    if (overlayFeedback) {
      overlayFeedback.hidden = true;
      overlayFeedback.classList.remove("error");
    }
    if (adminFeedback) {
      adminFeedback.hidden = true;
      adminFeedback.classList.remove("error");
    }
    inviteHintTimeoutId = null;
  }, 4000);
};

const setWorkspaceFeedback = (message, { error = false } = {}) => {
  const feedback = elements.workspace.feedback;
  if (!feedback) {
    return;
  }
  if (workspaceFeedbackTimeoutId) {
    clearTimeout(workspaceFeedbackTimeoutId);
    workspaceFeedbackTimeoutId = null;
  }
  if (!message) {
    feedback.hidden = true;
    feedback.classList.remove("error");
    feedback.textContent = "";
    return;
  }
  feedback.textContent = message;
  feedback.hidden = false;
  feedback.classList.toggle("error", error);
  workspaceFeedbackTimeoutId = setTimeout(() => {
    feedback.hidden = true;
    feedback.classList.remove("error");
    workspaceFeedbackTimeoutId = null;
  }, 4000);
};

const updateUserBar = () => {
  const container = elements.userBar.container;
  const account = sessionState.account;
  const isSuperAdmin = account?.role === "superadmin";

  if (container) {
    if (!sessionState.authenticated || !account || isSuperAdmin) {
      container.hidden = true;
    } else {
      container.hidden = false;
      if (elements.userBar.info) {
        elements.userBar.info.textContent = `${account.username} (${account.role})`;
      }
    }
  }

  const superBar = elements.superAdmin.userBar;
  const superInfo = elements.superAdmin.userInfo;
  if (superBar) {
    if (!sessionState.authenticated || !account || !isSuperAdmin) {
      superBar.hidden = true;
      if (superInfo) {
        superInfo.textContent = "";
      }
    } else {
      superBar.hidden = false;
      if (superInfo) {
        superInfo.textContent = `${account.username} (super admin)`;
      }
    }
  }
};

const copyInviteLink = async ({ target = "auto" } = {}) => {
  if (sessionState.account?.role !== "admin" || !sessionState.inviteToken) {
    return;
  }
  const link = buildInviteLink(sessionState.inviteToken);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(link);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = link;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setInviteFeedback("Invite link copied!", { target });
  } catch (error) {
    console.error("Failed to copy invite link:", error);
    setInviteFeedback("Unable to copy invite link.", { target, error: true });
  }
};

const rotateInviteLink = async () => {
  if (sessionState.account?.role !== "admin") {
    return;
  }
  try {
    const result = await request("/api/auth/invite/rotate", { method: "POST" });
    sessionState.inviteToken = result.invite_token;
    updateAdminInviteCard();
    setInviteFeedback("New invite link generated.", { target: "admin" });
  } catch (error) {
    console.error("Failed to rotate invite link:", error);
    setInviteFeedback(error.message || "Unable to rotate invite link.", { target: "admin", error: true });
  }
};

const showInviteOverlay = () => {
  const overlay = elements.auth.overlay;
  if (!overlay?.container || !sessionState.inviteToken) {
    return;
  }
  overlay.link.textContent = buildInviteLink(sessionState.inviteToken);
  overlay.container.hidden = false;
  document.body.classList.add("modal-open");
  setInviteFeedback("", { target: "overlay" });
};

const hideInviteOverlay = async () => {
  const overlay = elements.auth.overlay;
  if (!overlay?.container) {
    return;
  }
  overlay.container.hidden = true;
  document.body.classList.remove("modal-open");
  setInviteFeedback("", { target: "overlay" });
  resetAuthForms();
  currentAuthView = null;
  inviteTokenFromQuery = null;
  await loadState();
};

const logout = async () => {
  try {
    await request("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error("Failed to log out:", error);
  } finally {
    resetSuperState();
    await refreshSession();
  }
};

const setFieldsDisabled = (form, disabled) => {
  if (!form) {
    return;
  }
  Array.from(form.elements).forEach((element) => {
    element.disabled = disabled;
  });
  form.classList.toggle("read-only", disabled);
};

const applyRolePermissions = () => {
  const role = sessionState.account?.role || "guest";
  const isAdmin = role === "admin";
  document.body.dataset.role = role;

  setFieldsDisabled(elements.form, !isAdmin);
  if (elements.form) {
    const controls = elements.form.closest(".controls");
    if (controls) {
      controls.classList.toggle("read-only", !isAdmin);
    }
  }
  setFieldsDisabled(elements.adminForm, !isAdmin);
  if (elements.billing?.form) {
    setFieldsDisabled(elements.billing.form, !isAdmin);
    const adminCard = elements.billing.form.closest(".admin-card");
    if (adminCard) {
      adminCard.classList.toggle("read-only", !isAdmin);
    }
  }
  setFieldsDisabled(elements.fixed.form, !isAdmin);
  if (elements.fixed.form) {
    const fixedGrid = elements.fixed.form.closest(".fixed-grid");
    if (fixedGrid) {
      fixedGrid.classList.toggle("read-only", !isAdmin);
    }
  }
  setFieldsDisabled(elements.workspace.form, !isAdmin);
  if (elements.workspace.form) {
    const workspaceCard = elements.workspace.form.closest(".admin-card");
    if (workspaceCard) {
      workspaceCard.classList.toggle("read-only", !isAdmin);
    }
  }
  if (!isAdmin) {
    setWorkspaceFeedback("");
  }

  if (elements.tbody) {
    elements.tbody.querySelectorAll(".delete-btn").forEach((button) => {
      button.hidden = !isAdmin;
    });
  }

  if (elements.fixed.tableBody) {
    elements.fixed.tableBody
      .querySelectorAll(".fixed-name-input, .fixed-category-select, .fixed-amount-input")
      .forEach((input) => {
        input.disabled = !isAdmin;
      });
    elements.fixed.tableBody
      .querySelectorAll(".fixed-save, .fixed-delete")
      .forEach((button) => {
        button.hidden = !isAdmin;
        button.disabled = !isAdmin;
      });
  }
};

const updateFeedbackCounter = () => {
  const { messageInput, counter } = elements.feedbackWidget;
  if (!messageInput || !counter) {
    return;
  }
  const length = messageInput.value.length;
  counter.textContent = `${length} / 4000`;
};

const setFeedbackStatus = (message, variant = null) => {
  const { status } = elements.feedbackWidget;
  if (!status) {
    return;
  }
  status.textContent = message || "";
  status.hidden = !message;
  status.classList.remove("success", "error");
  if (message && variant) {
    status.classList.add(variant);
  }
};

const resetFeedbackForm = () => {
  const { form, messageInput, contactInput } = elements.feedbackWidget;
  if (form) {
    form.reset();
  }
  if (messageInput) {
    messageInput.value = "";
  }
  if (contactInput) {
    contactInput.value = "";
  }
  updateFeedbackCounter();
};

const toggleFeedbackPanel = (open = null) => {
  const { toggle, panel, messageInput } = elements.feedbackWidget;
  if (!toggle || !panel) {
    return;
  }
  const shouldOpen = typeof open === "boolean" ? open : !feedbackState.open;
  feedbackState.open = shouldOpen;
  toggle.setAttribute("aria-expanded", String(shouldOpen));
  panel.hidden = !shouldOpen;
  if (shouldOpen) {
    setFeedbackStatus("");
    if (messageInput) {
      messageInput.focus();
    }
  }
  if (!shouldOpen) {
    setFeedbackStatus("");
  }
};

const updateFeedbackWidgetVisibility = () => {
  const { toggle, panel } = elements.feedbackWidget;
  if (!toggle || !panel) {
    return;
  }
  if (!sessionState.authenticated) {
    toggle.hidden = true;
    panel.hidden = true;
    feedbackState.open = false;
    feedbackState.busy = false;
    resetFeedbackForm();
    setFeedbackStatus("");
    return;
  }
  toggle.hidden = false;
  panel.hidden = !feedbackState.open;
  toggle.setAttribute("aria-expanded", String(feedbackState.open));
};

const buildFeedbackContext = () => {
  if (!sessionState.authenticated) {
    return null;
  }
  if (sessionState.account?.role === "superadmin") {
    return `Super admin · ${currentSuperTab}`;
  }
  const activeButton = document.querySelector("#app-root .tabs .tab-button.active");
  if (activeButton) {
    const label = activeButton.textContent?.trim();
    if (label) {
      return `App tab · ${label}`;
    }
  }
  return null;
};

const submitFeedback = async () => {
  const { messageInput, contactInput, submit } = elements.feedbackWidget;
  if (!messageInput) {
    return;
  }

  const message = messageInput.value.trim();
  const contact = contactInput?.value.trim() || "";

  if (!message) {
    setFeedbackStatus("Please add a short message before sending.", "error");
    messageInput.focus();
    return;
  }

  const payload = { message };
  if (contact) {
    payload.contact = contact;
  }
  const context = buildFeedbackContext();
  if (context) {
    payload.context = context;
  }
  if (sessionState.account?.role === "superadmin" && sessionState.workspaceName) {
    payload.workspace_name = sessionState.workspaceName;
  }

  feedbackState.busy = true;
  setFeedbackStatus("Sending feedback…");
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Sending…";
  }

  try {
    await request("/api/feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setFeedbackStatus("Thanks for the feedback!", "success");
    resetFeedbackForm();
    if (sessionState.account?.role === "superadmin") {
      await loadSuperState();
    }
    setTimeout(() => {
      setFeedbackStatus("");
      toggleFeedbackPanel(false);
    }, 2500);
  } catch (error) {
    console.error("Failed to submit feedback:", error);
    setFeedbackStatus(error.message || "Failed to send feedback.", "error");
  } finally {
    feedbackState.busy = false;
    if (submit) {
      submit.disabled = false;
      submit.textContent = "Send";
    }
  }
};

const updateAdminInviteCard = () => {
  const { card, link } = elements.adminInvite;
  if (!card || !link) {
    return;
  }

  const isAdmin = sessionState.authenticated && sessionState.account?.role === "admin";
  if (!isAdmin || !sessionState.inviteToken) {
    card.hidden = true;
    setInviteFeedback("", { target: "admin" });
    return;
  }

  card.hidden = false;
  link.textContent = buildInviteLink(sessionState.inviteToken);
};

const updateUIForSession = () => {
  const authed = sessionState.authenticated;
  const role = sessionState.account?.role || "guest";
  const isSuperAdmin = role === "superadmin";
  if (elements.auth.screen) {
    elements.auth.screen.hidden = authed;
  }
  if (elements.appRoot) {
    elements.appRoot.hidden = !authed || isSuperAdmin;
  }
  if (elements.superAdmin.root) {
    elements.superAdmin.root.hidden = !authed || !isSuperAdmin;
  }
  if (isSuperAdmin) {
    setSuperTab(currentSuperTab);
  }
  updateUserBar();
  applyRolePermissions();
  updateAdminInviteCard();
  renderWorkspace();
  updateFeedbackWidgetVisibility();

  if (!authed) {
    const defaultView = inviteTokenFromQuery ? "register-renter" : "menu";
    const viewToUse = currentAuthView || defaultView;
    setAuthView(viewToUse, { preserveValues: true, skipFocus: true });
  } else {
    currentAuthView = null;
  }
};

const refreshSession = async () => {
  try {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    if (!response.ok) {
      throw new Error("Failed to load session");
    }
    const data = await response.json();
    if (data.authenticated) {
      sessionState.authenticated = true;
      sessionState.account = data.account || null;
      sessionState.inviteToken = data.invite_token || null;
      sessionState.workspaceName = data.workspace?.name || "";
      sessionState.csrfToken = data.csrf_token || null;
    } else {
      sessionState.authenticated = false;
      sessionState.account = null;
      sessionState.inviteToken = null;
      sessionState.workspaceName = "";
      sessionState.csrfToken = null;
    }
  } catch (error) {
    console.error("Failed to refresh session:", error);
    sessionState.authenticated = false;
    sessionState.account = null;
    sessionState.inviteToken = null;
    sessionState.workspaceName = "";
    sessionState.csrfToken = null;
  }

  if (!sessionState.authenticated || sessionState.account?.role !== "superadmin") {
    resetSuperState();
  }

  updateUIForSession();
  return sessionState.authenticated;
};

const ensureSelectedAwayUser = () => {
  const ids = appState.users.map((user) => user.id);
  if (!ids.length) {
    selectedAwayUserId = null;
    return;
  }
  if (!ids.includes(selectedAwayUserId)) {
    selectedAwayUserId = ids[0];
  }
};

const ensureSelectedAbonoUser = () => {
  const ids = appState.users.map((user) => user.id);
  if (!ids.length) {
    selectedAbonoUserId = null;
    return;
  }
  if (!ids.includes(selectedAbonoUserId)) {
    selectedAbonoUserId = ids[0];
  }
};

const getAwayUser = () => getUserById(selectedAwayUserId);
const getAbonoUser = () => getUserById(selectedAbonoUserId);

const applyState = (data) => {
  const workspace = data.workspace ?? {};
  appState.workspace.name =
    typeof workspace.name === "string" ? workspace.name : appState.workspace.name || "";
  appState.users = Array.isArray(data.users) ? data.users : [];
  appState.expenses = { ...appState.expenses, ...(data.expenses ?? {}) };
  appState.totals = { ...appState.totals, ...(data.totals ?? {}) };
  appState.period = { ...appState.period, ...(data.period ?? {}) };
  appState.fixed = Array.isArray(data.fixed) ? data.fixed : [];
  const meta = data.meta ?? {};
  appState.meta = {
    ...appState.meta,
    ...meta,
    fixed_totals: {
      ...appState.meta.fixed_totals,
      ...(meta.fixed_totals ?? {}),
    },
  };
  const validIds = new Set(appState.users.map((user) => user.id));
  Array.from(openDetails).forEach((id) => {
    if (!validIds.has(id)) {
      openDetails.delete(id);
    }
  });
  ensureSelectedAwayUser();
  ensureSelectedAbonoUser();
};

const applySuperState = (data) => {
  superState.tenants = Array.isArray(data?.tenants) ? data.tenants : [];
  superState.admins = Array.isArray(data?.admins) ? data.admins : [];
  superState.residents = Array.isArray(data?.residents) ? data.residents : [];
  superState.feedbacks = Array.isArray(data?.feedbacks) ? data.feedbacks : [];
  superState.stats = { ...superState.stats, ...(data?.stats ?? {}) };
  const validIds = new Set(superState.tenants.map((tenant) => tenant.id));
  Array.from(openSuperDetails).forEach((id) => {
    if (!validIds.has(id)) {
      openSuperDetails.delete(id);
    }
  });
};

const loadState = async () => {
  if (!sessionState.authenticated || sessionState.account?.role === "superadmin") {
    return;
  }
  try {
    const data = await request("/api/state");
    applyState(data);
    render();
    syncAdminForm();
  } catch (error) {
    if (error.status === 401) {
      return;
    }
    console.error("Failed to load state:", error);
  }
};

const loadSuperState = async () => {
  if (!sessionState.authenticated || sessionState.account?.role !== "superadmin") {
    return;
  }
  try {
    const data = await request("/api/super/state");
    applySuperState(data);
    renderSuperAdmin();
  } catch (error) {
    console.error("Failed to load super admin state:", error);
  }
};

const addUser = async (name) => {
  try {
    await request("/api/users", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    await loadState();
  } catch (error) {
    console.error("Failed to add user:", error);
  }
};

const deleteUser = async (id) => {
  try {
    await request(`/api/users/${id}`, { method: "DELETE" });
    openDetails.delete(id);
    await loadState();
  } catch (error) {
    console.error("Failed to delete user:", error);
  }
};

const createAwayRecord = async ({ userId, start, end }) => {
  try {
    await request("/api/outs", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, start, end }),
    });
    await loadState();
  } catch (error) {
    console.error("Failed to create away record:", error);
  }
};

const updateAwayRecord = async (recordId, values) => {
  try {
    await request(`/api/outs/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    });
    await loadState();
  } catch (error) {
    console.error("Failed to update away record:", error);
    await loadState();
  }
};

const deleteAwayRecord = async (recordId) => {
  try {
    await request(`/api/outs/${recordId}`, { method: "DELETE" });
    await loadState();
  } catch (error) {
    console.error("Failed to delete away record:", error);
  }
};

const uploadReceipt = async (userId, file) => {
  const formData = new FormData();
  formData.append("file", file);

  try {
    const options = {
      method: "POST",
      credentials: "include",
      body: formData,
    };
    if (sessionState.csrfToken) {
      options.headers = { "X-CSRF-Token": sessionState.csrfToken };
    }
    await fetch(`/api/users/${userId}/receipts`, options).then((response) => {
      if (!response.ok) {
        return response.json().then((data) => {
          throw new Error(data.message || "Failed to upload receipt");
        });
      }
    });
    await loadState();
  } catch (error) {
    console.error("Failed to upload receipt:", error);
  }
};

const deleteReceipt = async (userId, receiptId) => {
  try {
    const options = {
      method: "DELETE",
      credentials: "include",
    };
    if (sessionState.csrfToken) {
      options.headers = { "X-CSRF-Token": sessionState.csrfToken };
    }
    await fetch(`/api/users/${userId}/receipts/${receiptId}`, options).then((response) => {
      if (!response.ok) {
        return response.json().then((data) => {
          throw new Error(data.message || "Failed to delete receipt");
        });
      }
    });
    await loadState();
  } catch (error) {
    console.error("Failed to delete receipt:", error);
  }
};

const deleteSuperTenant = async (tenantId) => {
  try {
    await request(`/api/super/tenants/${tenantId}`, { method: "DELETE" });
    openSuperDetails.delete(tenantId);
    await loadSuperState();
  } catch (error) {
    console.error("Failed to purge tenant:", error);
  }
};

const deleteSuperAdminAccount = async (accountId) => {
  try {
    await request(`/api/super/admins/${accountId}`, { method: "DELETE" });
    await loadSuperState();
  } catch (error) {
    console.error("Failed to remove admin:", error);
  }
};

const deleteSuperResidentAccount = async (accountId) => {
  try {
    await request(`/api/super/renters/${accountId}`, { method: "DELETE" });
    await loadSuperState();
  } catch (error) {
    console.error("Failed to remove resident:", error);
  }
};

const toggleSuperTenantDetails = (tenantId) => {
  if (openSuperDetails.has(tenantId)) {
    openSuperDetails.delete(tenantId);
  } else {
    openSuperDetails.add(tenantId);
  }
  renderSuperAdmin();
};

const updateAbonoCredit = async (userId, value) => {
  const payload = {};
  if (typeof value === "number") {
    payload.various_credit = value;
  } else if (value && typeof value === "object") {
    const amount = Number(value.amount);
    if (Number.isFinite(amount)) {
      if (value.mineral) {
        payload.mineral_credit = amount;
      } else {
        payload.various_credit = amount;
      }
    }
  }

  if (Object.keys(payload).length === 0) {
    return;
  }

  try {
    await request(`/api/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    await loadState();
  } catch (error) {
    console.error("Failed to update abono credit:", error);
  }
};

const createFixedItem = async (payload) => {
  if (sessionState.account?.role !== "admin") {
    return;
  }
  try {
    await request("/api/fixed", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await loadState();
  } catch (error) {
    console.error("Failed to create fixed item:", error);
  }
};

const updateFixedItem = async (id, values) => {
  if (sessionState.account?.role !== "admin") {
    return;
  }
  try {
    await request(`/api/fixed/${id}`, {
      method: "PATCH",
      body: JSON.stringify(values),
    });
    await loadState();
  } catch (error) {
    console.error("Failed to update fixed item:", error);
  }
};

const deleteFixedItem = async (id) => {
  if (sessionState.account?.role !== "admin") {
    return;
  }
  try {
    await request(`/api/fixed/${id}`, { method: "DELETE" });
    await loadState();
  } catch (error) {
    console.error("Failed to delete fixed item:", error);
  }
};

const updateExpenses = async (values) => {
  if (sessionState.account?.role !== "admin") {
    return;
  }
  try {
    await request("/api/expenses", {
      method: "PATCH",
      body: JSON.stringify(values),
    });
    await loadState();
  } catch (error) {
    console.error("Failed to update expenses:", error);
  }
};

const updateWorkspaceName = async (name) => {
  if (sessionState.account?.role !== "admin") {
    throw new Error("Admin privileges required.");
  }
  const result = await request("/api/workspace", {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  const workspaceName = result?.workspace?.name || name;
  sessionState.workspaceName = workspaceName;
  appState.workspace.name = workspaceName;
  renderWorkspace();
};

const renderTotals = () => {
  categories.forEach((category) => {
    elements.totals[category].textContent = formatCurrency(normaliseCurrency(appState.totals[category]));
  });
  if (elements.totals.rent) {
    elements.totals.rent.textContent = formatCurrency(
      normaliseCurrency(appState.totals.rent ?? appState.expenses.rent ?? 0)
    );
  }
  if (elements.totals.abonoGeneral) {
    elements.totals.abonoGeneral.textContent = formatCurrency(
      normaliseCurrency(appState.totals.abono_general ?? 0)
    );
  }
  if (elements.totals.abonoMineral) {
    elements.totals.abonoMineral.textContent = formatCurrency(
      normaliseCurrency(appState.totals.abono_mineral ?? 0)
    );
  }
  elements.totals.grand.textContent = formatCurrency(normaliseCurrency(appState.totals.grand));
};

const getWorkspaceName = () => {
  const nameFromState = (appState.workspace?.name || "").trim();
  if (nameFromState) {
    return nameFromState;
  }
  return (sessionState.workspaceName || "").trim();
};

const renderWorkspace = () => {
  const display = elements.header?.workspaceName;
  const name = getWorkspaceName();
  const shouldShow = sessionState.authenticated && !!name;

  if (display) {
    display.textContent = shouldShow ? name : "";
    display.hidden = !shouldShow;
  }

  const input = elements.workspace?.nameInput;
  if (input && document.activeElement !== input) {
    input.value = name;
  }

  const baseTitle = baseDocumentTitle || "Dorm Expense Tracker";
  document.title = name ? `${name} · ${baseTitle}` : baseTitle;
};

const renderPeriod = () => {
  if (!elements.billingPeriod) {
    return;
  }

  const { start, end, total_days: totalDays, total_occupancy_days: occupancyDays } = appState.period;
  if (!start || !end) {
    elements.billingPeriod.textContent = "";
    return;
  }

  const dateFormatter = new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const formattedStart = dateFormatter.format(new Date(start));
  const formattedEnd = dateFormatter.format(new Date(end));

  const occupancyInfo =
    occupancyDays && occupancyDays > 0
      ? ` – ${occupancyDays} occupied day${occupancyDays === 1 ? "" : "s"}`
      : " – no away time recorded yet";

  elements.billingPeriod.textContent = `Current billing period: ${formattedStart} to ${formattedEnd} (${totalDays} day${totalDays === 1 ? "" : "s"})${occupancyInfo}`;

  if (elements.billing?.startInput) {
    elements.billing.startInput.value = start || "";
  }
  if (elements.billing?.endInput) {
    elements.billing.endInput.value = end || "";
  }
};

const populateMainRow = (row, user) => {
  row.dataset.userId = String(user.id);
  row.querySelector(".name").textContent = user.name;
  row.querySelector(".days").textContent = user.days_present ?? 0;

  const generalCredit = user.abono_credit ?? user.various_credit ?? 0;
  const mineralCredit = user.mineral_credit ?? 0;
  const rentShare = user.rent_share ?? 0;
  const utilitiesTotals = {};

  categories.forEach((category) => {
    const value = normaliseCurrency(user.share?.[category] ?? 0);
    utilitiesTotals[category] = value;
    const cell = row.querySelector(`.${category}`);
    if (cell) {
      cell.textContent = formatCurrency(value);
    }
  });

  const rentCell = row.querySelector(".rent");
  if (rentCell) {
    rentCell.textContent = formatCurrency(normaliseCurrency(rentShare));
  }

  const grossTotal = user.gross_total ??
    Object.values(utilitiesTotals).reduce((sum, value) => sum + value, 0) + rentShare;

  const totalCell = row.querySelector(".total");
  if (totalCell) {
    totalCell.textContent = formatCurrency(normaliseCurrency(grossTotal));
  }

  const creditCell = row.querySelector(".credit");
  if (creditCell) {
    creditCell.textContent = formatCurrency(normaliseCurrency(generalCredit));
  }

  const mineralCell = row.querySelector(".mineral-credit");
  if (mineralCell) {
    mineralCell.textContent = formatCurrency(normaliseCurrency(mineralCredit));
  }

  const balanceCell = row.querySelector(".amount-due");
  if (balanceCell) {
    const netTotal = user.net_total ?? grossTotal - generalCredit - mineralCredit;
    balanceCell.textContent = formatCurrency(normaliseCurrency(netTotal));
  }

  const detailButton = row.querySelector(".details-btn");
  if (detailButton) {
    const isOpen = openDetails.has(user.id);
    detailButton.textContent = isOpen ? "Hide Details" : "Details";
    detailButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }
};

const populateDetailRow = (row, user) => {
  row.dataset.userId = String(user.id);

  const setText = (selector, value) => {
    const el = row.querySelector(selector);
    if (el) {
      el.textContent = value;
    }
  };

  const setNote = (selector, value) => {
    const el = row.querySelector(selector);
    if (!el) {
      return;
    }
    if (value) {
      el.textContent = value;
      el.hidden = false;
    } else {
      el.textContent = "";
      el.hidden = true;
    }
  };

  const shareDetail = user.share_detail || {};
  const rentDetail = user.rent_detail || {};

  setText(".breakdown-days-present", user.days_present ?? 0);
  setText(".breakdown-days-out", user.days_out ?? 0);
  const rentShare = Number(user.rent_share ?? 0);
  setText(
    ".breakdown-rent",
    formatCurrency(normaliseCurrency(rentShare))
  );
  setText(
    ".breakdown-water",
    formatCurrency(normaliseCurrency(user.share?.water ?? 0))
  );
  setText(
    ".breakdown-electric",
    formatCurrency(normaliseCurrency(user.share?.electric ?? 0))
  );
  setText(
    ".breakdown-internet",
    formatCurrency(normaliseCurrency(user.share?.internet ?? 0))
  );
  setText(
    ".breakdown-total",
    formatCurrency(normaliseCurrency(user.share?.total ?? 0))
  );
  const generalAmount = Number(user.abono_credit ?? user.various_credit ?? 0);
  const mineralAmount = Number(user.mineral_credit ?? 0);
  setText(
    ".breakdown-credit",
    formatCurrency(normaliseCurrency(generalAmount))
  );
  setText(
    ".breakdown-mineral",
    formatCurrency(normaliseCurrency(mineralAmount))
  );
  const grossTotal = user.gross_total ?? (user.share?.total ?? 0) + rentShare;
  const netTotal = user.net_total ?? grossTotal - generalAmount - mineralAmount;
  setText(".breakdown-due", formatCurrency(normaliseCurrency(netTotal)));

  const totalDays =
    shareDetail.water?.total_days ??
    shareDetail.electric?.total_days ??
    shareDetail.internet?.total_days ??
    appState.period.total_days ??
    0;
  setNote(
    ".breakdown-days-note",
    buildDaysNote(Number(user.days_present ?? 0), Number(totalDays), Number(user.days_out ?? 0))
  );
  setNote(".breakdown-rent-note", buildRentNote(rentDetail));
  setNote(".breakdown-water-note", buildShareNote(shareDetail.water));
  setNote(".breakdown-electric-note", buildShareNote(shareDetail.electric));
  setNote(".breakdown-internet-note", buildShareNote(shareDetail.internet));
  setNote(".breakdown-utilities-note", buildUtilitiesNote(user.share));
  setNote(
    ".breakdown-amount-note",
    buildAmountNote(
      user.share?.total ?? 0,
      rentShare,
      generalAmount,
      mineralAmount,
      netTotal
    )
  );

  const receiptList = row.querySelector(".receipt-list");
  renderReceiptList(receiptList, user.receipts);
};

const renderUsers = () => {
  elements.tbody.innerHTML = "";

  if (!appState.users.length) {
    const row = document.createElement("tr");
    row.classList.add("empty-row");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.textContent = "Add residents to split the expenses.";
    row.appendChild(cell);
    elements.tbody.appendChild(row);
    return;
  }

  appState.users.forEach((user) => {
    const mainFragment = elements.rowTemplate.content.cloneNode(true);
    const mainRow = mainFragment.querySelector("tr");
    populateMainRow(mainRow, user);
    elements.tbody.appendChild(mainRow);

    if (elements.detailTemplate) {
      const detailFragment = elements.detailTemplate.content.cloneNode(true);
      const detailRow = detailFragment.querySelector("tr");
      populateDetailRow(detailRow, user);
      detailRow.hidden = !openDetails.has(user.id);
      elements.tbody.appendChild(detailRow);
    }
  });
};

const toggleDetailRow = (userId) => {
  const detailRow = elements.tbody.querySelector(
    `.user-details[data-user-id="${userId}"]`
  );
  if (!detailRow) {
    return;
  }

  const shouldShow = detailRow.hidden;
  if (shouldShow) {
    openDetails.add(userId);
    const user = appState.users.find((entry) => entry.id === userId);
    if (user) {
      populateDetailRow(detailRow, user);
    }
  } else {
    openDetails.delete(userId);
  }
  detailRow.hidden = !shouldShow;
};

const setPeriodConstraints = (input) => {
  if (!input) {
    return;
  }
  input.min = appState.period.start || "";
  input.max = appState.period.end || "";
};

const renderAwaySelector = () => {
  ensureSelectedAwayUser();
  const { select, addForm } = elements.away;
  if (!select) {
    return;
  }

  select.innerHTML = "";
  if (!appState.users.length) {
    select.disabled = true;
    select.value = "";
    if (addForm) {
      addForm.reset();
      addForm.classList.add("disabled");
    }
    selectedAwayUserId = null;
    return;
  }

  select.disabled = false;
  if (addForm) {
    addForm.classList.remove("disabled");
  }

  appState.users.forEach((user) => {
    const option = document.createElement("option");
    option.value = String(user.id);
    option.textContent = user.name;
    if (user.id === selectedAwayUserId) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  if (selectedAwayUserId) {
    select.value = String(selectedAwayUserId);
  }
};

const createAwayRow = (record) => {
  const row = document.createElement("tr");
  row.dataset.recordId = String(record.id);

  const startCell = document.createElement("td");
  const startInput = document.createElement("input");
  startInput.type = "date";
  startInput.className = "record-date out-start";
  startInput.value = record.start || "";
  setPeriodConstraints(startInput);
  startCell.appendChild(startInput);

  const endCell = document.createElement("td");
  const endInput = document.createElement("input");
  endInput.type = "date";
  endInput.className = "record-date out-end";
  endInput.value = record.end || "";
  setPeriodConstraints(endInput);
  endCell.appendChild(endInput);

  const daysCell = document.createElement("td");
  daysCell.className = "away-days";
  daysCell.textContent = record.days ?? 0;

  const actionsCell = document.createElement("td");
  actionsCell.className = "actions-col";
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "danger delete-away";
  deleteButton.textContent = "Delete";
  actionsCell.appendChild(deleteButton);

  row.append(startCell, endCell, daysCell, actionsCell);
  return row;
};

const renderAwayTable = () => {
  const { tableBody, emptyMessage, startInput, endInput } = elements.away;
  if (!tableBody || !emptyMessage) {
    return;
  }

  tableBody.innerHTML = "";
  const user = getAwayUser();

  if (startInput) {
    setPeriodConstraints(startInput);
    startInput.disabled = !user;
  }
  if (endInput) {
    setPeriodConstraints(endInput);
    endInput.disabled = !user;
  }

  const noUserSelected = !user;
  const records = user?.out_records ?? [];

  if (noUserSelected) {
    emptyMessage.hidden = false;
    emptyMessage.textContent = "Add residents to begin tracking time away.";
    return;
  }

  if (!records.length) {
    emptyMessage.hidden = false;
    emptyMessage.textContent = "This resident has not recorded any time away for this billing period.";
    return;
  }

  emptyMessage.hidden = true;
  records.forEach((record) => {
    tableBody.appendChild(createAwayRow(record));
  });
};

const renderAwayManager = () => {
  renderAwaySelector();
  renderAwayTable();
};

const renderAbonoPanel = () => {
  ensureSelectedAbonoUser();
  const {
    select,
    summaryTotal,
    summaryCredit,
    summaryMineral,
    summaryRent,
    summaryDue,
    creditForm,
    creditInput,
    mineralForm,
    mineralInput,
    receiptList,
    receiptEmpty,
    uploadForm,
    uploadInput,
  } = elements.abono;

  if (!select) {
    return;
  }

  const disableForms = () => {
    select.value = "";
    select.disabled = true;
    if (creditForm) {
      creditForm.classList.add("disabled");
      const submit = creditForm.querySelector("button[type='submit']");
      if (submit) {
        submit.disabled = true;
      }
    }
    if (creditInput) {
      creditInput.value = "";
      creditInput.disabled = true;
    }
    if (mineralForm) {
      mineralForm.classList.add("disabled");
      const submit = mineralForm.querySelector("button[type='submit']");
      if (submit) {
        submit.disabled = true;
      }
    }
    if (mineralInput) {
      mineralInput.value = "";
      mineralInput.disabled = true;
    }
    if (uploadForm) {
      uploadForm.classList.add("disabled");
      const submit = uploadForm.querySelector("button[type='submit']");
      if (submit) {
        submit.disabled = true;
      }
    }
    if (uploadInput) {
      uploadInput.value = "";
      uploadInput.disabled = true;
    }
    if (receiptList) {
      receiptList.innerHTML = "";
    }
    if (receiptEmpty) {
      receiptEmpty.hidden = false;
    }
    if (summaryTotal) {
      summaryTotal.textContent = formatCurrency(0);
    }
    if (summaryCredit) {
      summaryCredit.textContent = formatCurrency(0);
    }
    if (summaryMineral) {
      summaryMineral.textContent = formatCurrency(0);
    }
    if (summaryRent) {
      summaryRent.textContent = formatCurrency(0);
    }
    if (summaryDue) {
      summaryDue.textContent = formatCurrency(0);
    }
  };

  select.innerHTML = "";

  if (!appState.users.length) {
    select.disabled = true;
    select.value = "";
    selectedAbonoUserId = null;
    disableForms();
    return;
  }

  select.disabled = false;

  appState.users.forEach((user) => {
    const option = document.createElement("option");
    option.value = String(user.id);
    option.textContent = user.name;
    if (user.id === selectedAbonoUserId) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  const user = getAbonoUser();

  if (!user) {
    disableForms();
    return;
  }

  if (selectedAbonoUserId) {
    select.value = String(selectedAbonoUserId);
  }

  const generalAmount = Number(user.abono_credit ?? user.various_credit ?? 0);
  const mineralAmount = Number(user.mineral_credit ?? 0);
  const rentShare = Number(user.rent_share ?? 0);
  const utilitiesTotal = Number(user.share?.total ?? 0);
  const grossTotal = user.gross_total ?? utilitiesTotal + rentShare;

  select.disabled = false;
  if (creditForm) {
    creditForm.classList.remove("disabled");
    const submit = creditForm.querySelector("button[type='submit']");
    if (submit) {
      submit.disabled = false;
    }
  }
  if (creditInput) {
    creditInput.disabled = false;
    creditInput.value = generalAmount ? String(generalAmount) : "";
  }
  if (mineralForm) {
    mineralForm.classList.remove("disabled");
    const submit = mineralForm.querySelector("button[type='submit']");
    if (submit) {
      submit.disabled = false;
    }
  }
  if (mineralInput) {
    mineralInput.disabled = false;
    mineralInput.value = mineralAmount ? String(mineralAmount) : "";
  }
  if (uploadForm) {
    uploadForm.classList.remove("disabled");
    const submit = uploadForm.querySelector("button[type='submit']");
    if (submit) {
      submit.disabled = false;
    }
  }
  if (uploadInput) {
    uploadInput.disabled = false;
    uploadInput.value = "";
  }

  if (summaryTotal) {
    summaryTotal.textContent = formatCurrency(
      normaliseCurrency(utilitiesTotal)
    );
  }
  if (summaryCredit) {
    summaryCredit.textContent = formatCurrency(
      normaliseCurrency(generalAmount)
    );
  }
  if (summaryMineral) {
    summaryMineral.textContent = formatCurrency(
      normaliseCurrency(mineralAmount)
    );
  }
  if (summaryRent) {
    summaryRent.textContent = formatCurrency(
      normaliseCurrency(rentShare)
    );
  }
  if (summaryDue) {
    summaryDue.textContent = formatCurrency(
      normaliseCurrency(
        user.net_total ?? grossTotal - generalAmount - mineralAmount
      )
    );
  }

  const hasReceipts = !!(user.receipts && user.receipts.length);
  if (receiptList) {
    if (hasReceipts) {
      renderReceiptList(receiptList, user.receipts, "No receipts uploaded yet.", {
        showDelete: true,
      });
    } else {
      receiptList.innerHTML = "";
    }
  }
  if (receiptEmpty) {
    receiptEmpty.hidden = hasReceipts;
  }
};

const renderFixedPanel = () => {
  const { tableBody, emptyMessage } = elements.fixed;
  const isAdmin = sessionState.account?.role === "admin";
  if (!tableBody) {
    return;
  }

  tableBody.innerHTML = "";
  if (!appState.fixed.length) {
    if (emptyMessage) {
      emptyMessage.hidden = false;
    }
    return;
  }

  if (emptyMessage) {
    emptyMessage.hidden = true;
  }

  appState.fixed.forEach((item) => {
    const row = document.createElement("tr");
    row.dataset.fixedId = String(item.id);

    const nameCell = document.createElement("td");
    const nameField = document.createElement("input");
    nameField.type = "text";
    nameField.className = "fixed-name-input";
    nameField.value = item.name;
    nameField.disabled = !isAdmin;
    nameCell.appendChild(nameField);

    const categoryCell = document.createElement("td");
    const categoryField = document.createElement("select");
    categoryField.className = "fixed-category-select";
    [
      { value: "water", label: "Water" },
      { value: "electric", label: "Electric" },
      { value: "internet", label: "Internet" },
    ].forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option.value;
      opt.textContent = option.label;
      if (item.category === option.value) {
        opt.selected = true;
      }
      categoryField.appendChild(opt);
    });
    categoryField.disabled = !isAdmin;
    categoryCell.appendChild(categoryField);

    const amountCell = document.createElement("td");
    const amountField = document.createElement("input");
    amountField.type = "number";
    amountField.min = "0";
    amountField.step = "0.01";
    amountField.className = "fixed-amount-input";
    amountField.value = item.amount != null ? String(item.amount) : "";
    amountField.disabled = !isAdmin;
    amountCell.appendChild(amountField);

    const actionsCell = document.createElement("td");
    actionsCell.className = "actions-col";
    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "secondary fixed-save";
    saveButton.textContent = "Save";
    saveButton.disabled = !isAdmin;
    saveButton.hidden = !isAdmin;
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger fixed-delete";
    deleteButton.textContent = "Delete";
    deleteButton.disabled = !isAdmin;
    deleteButton.hidden = !isAdmin;
    actionsCell.append(saveButton, deleteButton);

    row.append(nameCell, categoryCell, amountCell, actionsCell);
    tableBody.appendChild(row);
  });
};

const renderCheckingPanel = () => {
  const {
    utilities,
    rent,
    fixed,
    abonoGeneral,
    abonoMineral,
    grand,
    residentTotal,
    difference,
    status,
    tableBody,
  } = elements.checking;

  if (!utilities || !tableBody) {
    return;
  }

  const utilitiesTotal = categories.reduce(
    (sum, category) => sum + normaliseCurrency(appState.totals[category] ?? 0),
    0
  );
  const rentTotal = normaliseCurrency(appState.totals.rent ?? appState.expenses.rent ?? 0);
  const fixedTotal = appState.fixed.reduce(
    (sum, item) => sum + normaliseCurrency(Number(item.amount) || 0),
    0
  );
  const generalTotal = normaliseCurrency(appState.totals.abono_general ?? 0);
  const mineralTotal = normaliseCurrency(appState.totals.abono_mineral ?? 0);
  const grandTotal = normaliseCurrency(appState.totals.grand ?? 0);
  const totalDue = appState.users.reduce(
    (sum, user) => sum + (Number(user.net_total) || 0),
    0
  );
  const creditedGeneral = appState.users.reduce(
    (sum, user) => sum + (Number(user.abono_credit ?? user.various_credit ?? 0) || 0),
    0
  );
  const creditedMineral = appState.users.reduce(
    (sum, user) => sum + (Number(user.mineral_credit ?? 0) || 0),
    0
  );

  const expectedGrand = normaliseCurrency(
    utilitiesTotal + rentTotal - generalTotal - mineralTotal
  );
  const balanceDelta = normaliseCurrency(grandTotal - totalDue);
  const totalsDelta = normaliseCurrency(grandTotal - expectedGrand);
  const generalDelta = normaliseCurrency(generalTotal - creditedGeneral);
  const mineralDelta = normaliseCurrency(mineralTotal - creditedMineral);

  utilities.textContent = formatCurrency(utilitiesTotal);
  if (rent) {
    rent.textContent = formatCurrency(rentTotal);
  }
  if (fixed) {
    fixed.textContent = formatCurrency(fixedTotal);
  }
  if (abonoGeneral) {
    abonoGeneral.textContent = formatCurrency(generalTotal);
  }
  if (abonoMineral) {
    abonoMineral.textContent = formatCurrency(mineralTotal);
  }
  if (grand) {
    grand.textContent = formatCurrency(grandTotal);
  }
  if (residentTotal) {
    residentTotal.textContent = formatCurrency(normaliseCurrency(totalDue));
  }
  if (difference) {
    difference.textContent = formatCurrency(balanceDelta);
  }
  if (status) {
    status.classList.remove("ok", "warn");
    const issues = [];
    if (Math.abs(balanceDelta) >= 0.01) {
      issues.push(`resident totals differ by ${formatCurrency(Math.abs(balanceDelta))}`);
    }
    if (Math.abs(totalsDelta) >= 0.01) {
      issues.push(`expense totals differ by ${formatCurrency(Math.abs(totalsDelta))}`);
    }
    if (Math.abs(generalDelta) >= 0.01) {
      issues.push(`general abono mismatch of ${formatCurrency(Math.abs(generalDelta))}`);
    }
    if (Math.abs(mineralDelta) >= 0.01) {
      issues.push(`mineral abono mismatch of ${formatCurrency(Math.abs(mineralDelta))}`);
    }

    if (!issues.length) {
      status.classList.add("ok");
      status.textContent = "Balanced: expenses, abonos, and resident totals line up.";
    } else {
      status.classList.add("warn");
      status.textContent = `Check entries: ${issues.join("; ")}.`;
    }
  }

  tableBody.innerHTML = "";
  if (!appState.users.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "Add residents to view balance information.";
    cell.classList.add("empty-row-cell");
    row.appendChild(cell);
    tableBody.appendChild(row);
    return;
  }

  appState.users.forEach((user) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = user.name;

    const utilitiesCell = document.createElement("td");
    utilitiesCell.textContent = formatCurrency(normaliseCurrency(user.share?.total ?? 0));
    utilitiesCell.classList.add("numeric-cell");

    const rentCell = document.createElement("td");
    rentCell.textContent = formatCurrency(normaliseCurrency(user.rent_share ?? 0));
    rentCell.classList.add("numeric-cell");

    const creditCell = document.createElement("td");
    creditCell.textContent = formatCurrency(normaliseCurrency(user.abono_credit ?? user.various_credit ?? 0));
    creditCell.classList.add("numeric-cell");

    const mineralCell = document.createElement("td");
    mineralCell.textContent = formatCurrency(normaliseCurrency(user.mineral_credit ?? 0));
    mineralCell.classList.add("numeric-cell");

    const dueCell = document.createElement("td");
    dueCell.textContent = formatCurrency(normaliseCurrency(user.net_total ?? 0));
    dueCell.classList.add("numeric-cell");

    row.append(nameCell, utilitiesCell, rentCell, creditCell, mineralCell, dueCell);
    tableBody.appendChild(row);
  });
};

const renderSuperStats = () => {
  const stats = superState.stats || {};
  if (elements.superAdmin.stats.tenants) {
    elements.superAdmin.stats.tenants.textContent = String(stats.tenant_count ?? superState.tenants.length ?? 0);
  }
  if (elements.superAdmin.stats.admins) {
    elements.superAdmin.stats.admins.textContent = String(stats.admin_count ?? superState.admins.length ?? 0);
  }
  if (elements.superAdmin.stats.residents) {
    elements.superAdmin.stats.residents.textContent = String(
      stats.resident_count ?? superState.residents.length ?? 0
    );
  }
};

const buildAccountListItem = ({ account, type }) => {
  const item = document.createElement("li");
  item.className = "super-account-item";

  const info = document.createElement("span");
  info.className = "account-label";
  info.textContent = account.username;

  const meta = document.createElement("span");
  meta.className = "account-meta";
  meta.textContent = `Last active: ${formatDateTime(account.last_active_at)}`;

  item.append(info, meta);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "danger";
  removeButton.dataset.accountId = String(account.id);
  if (type === "admin") {
    removeButton.classList.add("super-remove-admin");
    removeButton.textContent = "Remove Admin";
  } else if (type === "resident") {
    removeButton.classList.add("super-remove-resident");
    removeButton.textContent = "Remove Resident";
  } else {
    removeButton.classList.add("super-remove-account");
    removeButton.textContent = "Remove";
  }

  item.appendChild(removeButton);
  return item;
};

const renderSuperTenants = () => {
  const tbody = elements.superAdmin.tableBody;
  if (!tbody) {
    return;
  }
  tbody.innerHTML = "";
  if (!superState.tenants.length) {
    const emptyRow = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "No dorm workspaces registered yet.";
    cell.classList.add("empty-row-cell");
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
    return;
  }

  superState.tenants.forEach((tenant) => {
    const tenantId = Number(tenant.id);
    const isOpen = openSuperDetails.has(tenantId);

    const row = document.createElement("tr");
    row.dataset.tenantId = String(tenantId);

    const nameCell = document.createElement("th");
    nameCell.scope = "row";
    nameCell.className = "super-tenant-name";
    nameCell.textContent = tenant.name || `Dorm ${tenantId}`;

    const residentsCell = document.createElement("td");
    residentsCell.className = "numeric-cell";
    residentsCell.textContent = String(tenant.resident_count ?? tenant.residents?.length ?? 0);

    const adminsCell = document.createElement("td");
    adminsCell.className = "numeric-cell";
    adminsCell.textContent = String(tenant.admin_count ?? (tenant.admins?.length ?? 0));

    const activityCell = document.createElement("td");
    activityCell.textContent = formatDateTime(tenant.last_active_at);

    const actionsCell = document.createElement("td");
    actionsCell.className = "actions-col";
    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "secondary super-tenant-details";
    detailButton.textContent = isOpen ? "Hide Details" : "Details";
    detailButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
    const purgeButton = document.createElement("button");
    purgeButton.type = "button";
    purgeButton.className = "danger super-tenant-purge";
    purgeButton.textContent = "Purge Dorm";
    actionsCell.append(detailButton, purgeButton);

    row.append(nameCell, residentsCell, adminsCell, activityCell, actionsCell);
    tbody.appendChild(row);

    const detailRow = document.createElement("tr");
    detailRow.className = "super-tenant-detail";
    detailRow.dataset.tenantId = String(tenantId);
    detailRow.hidden = !isOpen;
    const detailCell = document.createElement("td");
    detailCell.colSpan = 5;

    const detailCard = document.createElement("div");
    detailCard.className = "super-detail-card";

    const buildSection = (title, items, options = {}) => {
      const section = document.createElement("section");
      section.className = "super-detail-section";
      const heading = document.createElement("h3");
      heading.textContent = title;
      section.appendChild(heading);
      const list = document.createElement("ul");
      list.className = "super-account-list";
      if (!items || !items.length) {
        const emptyItem = document.createElement("li");
        emptyItem.className = "empty-row-cell";
        emptyItem.textContent = options.emptyMessage || "No records.";
        list.appendChild(emptyItem);
      } else {
        items.forEach((entry) => {
          const isAccount = entry && typeof entry.username === "string";
          if (!isAccount) {
            const item = document.createElement("li");
            item.className = "super-resident-item";
            item.textContent = entry?.name || "Unnamed resident";
            list.appendChild(item);
            return;
          }
          list.appendChild(
            buildAccountListItem({
              account: entry,
              type: options.type,
            })
          );
        });
      }
      section.appendChild(list);
      return section;
    };

    detailCard.appendChild(
      buildSection("Admins", tenant.admins || [], { type: "admin", emptyMessage: "No admins linked." })
    );
    detailCard.appendChild(
      buildSection("Residents", tenant.residents || [], {
        type: "resident",
        emptyMessage: "No resident accounts linked.",
      })
    );

    detailCell.appendChild(detailCard);
    detailRow.appendChild(detailCell);
    tbody.appendChild(detailRow);
  });
};

const renderSuperFeedbacks = () => {
  const tbody = elements.superAdmin.feedbackBody;
  const empty = elements.superAdmin.feedbackEmpty;
  if (!tbody) {
    return;
  }

  tbody.innerHTML = "";

  const feedbackEntries = [...superState.feedbacks];
  feedbackEntries.sort((a, b) => {
    const dateA = new Date(a?.created_at ?? 0).getTime();
    const dateB = new Date(b?.created_at ?? 0).getTime();
    return dateB - dateA;
  });

  if (!feedbackEntries.length) {
    if (empty) {
      empty.hidden = false;
    }
    return;
  }

  if (empty) {
    empty.hidden = true;
  }

  feedbackEntries.forEach((entry) => {
    const row = document.createElement("tr");

    const createdCell = document.createElement("td");
    createdCell.textContent = formatDateTime(entry?.created_at);
    row.appendChild(createdCell);

    const workspaceCell = document.createElement("td");
    const tenantName = entry?.workspace_name || (entry?.tenant_id ? `Dorm ${entry.tenant_id}` : "—");
    workspaceCell.textContent = tenantName;
    row.appendChild(workspaceCell);

    const userCell = document.createElement("td");
    const meta = document.createElement("div");
    meta.className = "super-feedback-meta";

    const username = document.createElement("span");
    username.textContent = entry?.username || "Unknown";
    meta.appendChild(username);

    const roleLabel = formatRoleLabel(entry?.role);
    if (roleLabel) {
      const roleSpan = document.createElement("span");
      roleSpan.className = "feedback-role";
      roleSpan.textContent = roleLabel;
      meta.appendChild(roleSpan);
    }

    userCell.appendChild(meta);
    row.appendChild(userCell);

    const contactCell = document.createElement("td");
    contactCell.textContent = entry?.contact || "—";
    row.appendChild(contactCell);

    const messageCell = document.createElement("td");
    const messageBlock = document.createElement("p");
    messageBlock.className = "super-feedback-message";
    messageBlock.textContent = entry?.message || "";
    messageCell.appendChild(messageBlock);

    if (entry?.context) {
      const contextNote = document.createElement("span");
      contextNote.className = "feedback-context";
      contextNote.textContent = `Context: ${entry.context}`;
      messageCell.appendChild(contextNote);
    }

    row.appendChild(messageCell);
    tbody.appendChild(row);
  });
};

const setSuperTab = (tabId) => {
  currentSuperTab = tabId;
  const config = [
    {
      id: "overview",
      button: elements.superAdmin.tabs.overview,
      panel: elements.superAdmin.panels.overview,
    },
    {
      id: "feedbacks",
      button: elements.superAdmin.tabs.feedbacks,
      panel: elements.superAdmin.panels.feedbacks,
    },
  ];

  config.forEach(({ id, button, panel }) => {
    const selected = id === tabId;
    if (button) {
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    if (panel) {
      panel.hidden = !selected;
    }
  });
};

const renderSuperAdmin = () => {
  if (elements.superAdmin.root?.hidden) {
    return;
  }
  setSuperTab(currentSuperTab);
  renderSuperStats();
  const feedbackTab = elements.superAdmin.tabs.feedbacks;
  if (feedbackTab) {
    const count = Number(superState.stats?.feedback_count ?? superState.feedbacks.length ?? 0);
    feedbackTab.textContent = count > 0 ? `Feedbacks (${count})` : "Feedbacks";
  }
  renderSuperTenants();
  renderSuperFeedbacks();
};

const render = () => {
  if (sessionState.account?.role === "superadmin") {
    renderSuperAdmin();
    return;
  }
  renderWorkspace();
  renderUsers();
  renderTotals();
  renderPeriod();
  renderAwayManager();
  renderAbonoPanel();
  renderCheckingPanel();
  renderFixedPanel();
  applyRolePermissions();
};

if (elements.auth.menuButtons?.length) {
  elements.auth.menuButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.target;
      if (!view) {
        return;
      }
      setAuthView(view, { resetHidden: true });
      if (view === "register-renter" && inviteTokenFromQuery && elements.auth.inputs.renterToken) {
        elements.auth.inputs.renterToken.value = inviteTokenFromQuery;
      }
    });
  });
}

if (elements.auth.backButtons?.length) {
  elements.auth.backButtons.forEach((button) => {
    button.addEventListener("click", () => {
      showAuthMessage("");
      setAuthView("menu", { skipFocus: true, resetHidden: true });
    });
  });
}

const handleAuthRequest = async ({
  endpoint,
  payload,
  submitButton,
  onSuccess,
  loadingText,
  deferPostAuth = false,
  errorView,
}) => {
  const originalText = submitButton?.textContent;
  if (submitButton) {
    submitButton.disabled = true;
    if (loadingText) {
      submitButton.textContent = loadingText;
    }
  }
  try {
    await request(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const authenticated = await refreshSession();
    if (authenticated) {
      if (deferPostAuth) {
        if (typeof onSuccess === "function") {
          onSuccess();
        }
      } else {
        resetAuthForms();
        currentAuthView = null;
        showAuthMessage("");
        inviteTokenFromQuery = null;
        if (typeof onSuccess === "function") {
          onSuccess();
        }
        if (sessionState.account?.role === "superadmin") {
          await loadSuperState();
        } else {
          await loadState();
        }
      }
    }
  } catch (error) {
    console.error(`Authentication request failed for ${endpoint}:`, error);
    let viewOptions = null;
    if (errorView) {
      viewOptions = { view: errorView, options: { preserveValues: true, skipFocus: true } };
    } else if (payload.token) {
      viewOptions = { view: "register-renter", options: { preserveValues: true, skipFocus: true } };
    } else if (payload.username && endpoint.includes("register")) {
      viewOptions = { view: "register-admin", options: { preserveValues: true, skipFocus: true } };
    }
    if (viewOptions) {
      setAuthView(viewOptions.view, { ...viewOptions.options, keepMessage: true });
    }
    showAuthMessage(error.message || "Request failed.");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      if (loadingText) {
        submitButton.textContent = originalText;
      }
    }
  }
};

if (elements.auth.forms?.loginAdmin) {
  elements.auth.forms.loginAdmin.addEventListener("submit", async (event) => {
    event.preventDefault();
    const dormName = elements.auth.inputs.loginAdminDormName?.value.trim() || "";
    const username = elements.auth.inputs.loginAdminUsername?.value.trim() || "";
    const password = elements.auth.inputs.loginAdminPassword?.value || "";
    if (!username || !password) {
      setAuthView("login-admin", { preserveValues: true, skipFocus: true, keepMessage: true });
      showAuthMessage("Username and password are required.");
      return;
    }
    showAuthMessage("");
    const submitButton = event.target.querySelector("button[type='submit']");
    const payload = { username, password };
    if (dormName) {
      payload.dorm_name = dormName;
    }
    await handleAuthRequest({
      endpoint: "/api/auth/login",
      payload,
      submitButton,
      loadingText: "Logging in...",
      errorView: "login-admin",
    });
  });
}

if (elements.auth.forms?.loginRenter) {
  elements.auth.forms.loginRenter.addEventListener("submit", async (event) => {
    event.preventDefault();
    const dormName = elements.auth.inputs.loginRenterDormName?.value.trim() || "";
    const username = elements.auth.inputs.loginRenterUsername?.value.trim() || "";
    const password = elements.auth.inputs.loginRenterPassword?.value || "";
    if (!username || !password) {
      setAuthView("login-renter", { preserveValues: true, skipFocus: true, keepMessage: true });
      showAuthMessage("Username and password are required.");
      return;
    }
    showAuthMessage("");
    const submitButton = event.target.querySelector("button[type='submit']");
    const payload = { username, password };
    if (dormName) {
      payload.dorm_name = dormName;
    }
    await handleAuthRequest({
      endpoint: "/api/auth/login",
      payload,
      submitButton,
      loadingText: "Logging in...",
      errorView: "login-renter",
    });
  });
}

if (elements.auth.forms?.registerAdmin) {
  elements.auth.forms.registerAdmin.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = elements.auth.inputs.registerAdminUsername?.value.trim() || "";
    const password = elements.auth.inputs.registerAdminPassword?.value || "";
    const dormName = elements.auth.inputs.registerAdminDormName?.value.trim() || "";
    if (!username || !password || !dormName) {
      setAuthView("register-admin", { preserveValues: true, skipFocus: true, keepMessage: true });
      showAuthMessage("Username, password, and dorm name are required.");
      return;
    }
    showAuthMessage("");
    const submitButton = event.target.querySelector("button[type='submit']");
    await handleAuthRequest({
      endpoint: "/api/auth/register",
      payload: { username, password, dorm_name: dormName },
      submitButton,
      loadingText: "Registering...",
      onSuccess: () => {
        showInviteOverlay();
      },
      deferPostAuth: true,
      errorView: "register-admin",
    });
  });
}

if (elements.auth.forms?.registerRenter) {
  elements.auth.forms.registerRenter.addEventListener("submit", async (event) => {
    event.preventDefault();
    const tokenInput = elements.auth.inputs.renterToken;
    const token = tokenInput?.value.trim() || inviteTokenFromQuery || "";
    const username = elements.auth.inputs.renterUsername?.value.trim() || "";
    const password = elements.auth.inputs.renterPassword?.value || "";
    if (!token || !username || !password) {
      setAuthView("register-renter", { preserveValues: true, skipFocus: true, keepMessage: true });
      showAuthMessage("Invite token, username, and password are required.");
      return;
    }
    showAuthMessage("");
    const submitButton = event.target.querySelector("button[type='submit']");
    await handleAuthRequest({
      endpoint: "/api/auth/renter-register",
      payload: { token, username, password },
      submitButton,
      loadingText: "Creating account...",
      errorView: "register-renter",
    });
  });
}

if (elements.logoutButtons?.length) {
  const handleLogout = async () => {
    await logout();
    setInviteFeedback("", { target: "admin" });
    setInviteFeedback("", { target: "overlay" });
  };
  elements.logoutButtons.forEach((button) => {
    button.addEventListener("click", handleLogout);
  });
}

if (elements.adminInvite.copyBtn) {
  elements.adminInvite.copyBtn.addEventListener("click", () => {
    copyInviteLink({ target: "admin" });
  });
}

if (elements.adminInvite.rotateBtn) {
  elements.adminInvite.rotateBtn.addEventListener("click", () => {
    rotateInviteLink();
  });
}

if (elements.superAdmin.tableBody) {
  elements.superAdmin.tableBody.addEventListener("click", async (event) => {
    const detailButton = event.target.closest(".super-tenant-details");
    const purgeButton = event.target.closest(".super-tenant-purge");
    const removeAdminButton = event.target.closest(".super-remove-admin");
    const removeResidentButton = event.target.closest(".super-remove-resident");

    const detailRow = event.target.closest(".super-tenant-detail");
    const headerRow = event.target.closest("tr[data-tenant-id]");
    const contextRow = detailRow || headerRow;
    const tenantId = contextRow ? Number(contextRow.dataset.tenantId) : NaN;

    if (detailButton) {
      if (Number.isFinite(tenantId)) {
        toggleSuperTenantDetails(tenantId);
      }
      return;
    }

    if (purgeButton) {
      if (Number.isFinite(tenantId)) {
        const confirmed = window.confirm(
          "This will permanently delete the dorm, its admins, residents, and stored data. Continue?"
        );
        if (confirmed) {
          await deleteSuperTenant(tenantId);
        }
      }
      return;
    }

    if (removeAdminButton) {
      const accountId = Number(removeAdminButton.dataset.accountId);
      if (Number.isFinite(accountId)) {
        const confirmed = window.confirm("Remove this admin account?");
        if (confirmed) {
          await deleteSuperAdminAccount(accountId);
        }
      }
      return;
    }

    if (removeResidentButton) {
      const accountId = Number(removeResidentButton.dataset.accountId);
      if (Number.isFinite(accountId)) {
        const confirmed = window.confirm("Remove this resident account?");
        if (confirmed) {
          await deleteSuperResidentAccount(accountId);
        }
      }
    }
  });
}

if (elements.auth.overlay?.copyBtn) {
  elements.auth.overlay.copyBtn.addEventListener("click", () => {
    copyInviteLink({ target: "overlay" });
  });
}

if (elements.auth.overlay?.continueBtn) {
  elements.auth.overlay.continueBtn.addEventListener("click", () => {
    hideInviteOverlay().catch((error) => {
      console.error("Failed to close invite overlay:", error);
    });
  });
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sessionState.account?.role !== "admin") {
    return;
  }
  const formData = new FormData(elements.form);
  const name = formData.get("name").trim();

  if (!name) {
    elements.form.name.focus();
    return;
  }

  elements.form.reset();
  elements.form.name.focus();
  await addUser(name);
});

elements.tbody.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest(".delete-btn");
  if (deleteButton) {
    if (sessionState.account?.role !== "admin") {
      return;
    }
    const row = deleteButton.closest("tr");
    if (row) {
      await deleteUser(Number(row.dataset.userId));
    }
    return;
  }

  const detailButton = event.target.closest(".details-btn");
  if (detailButton) {
    const row = detailButton.closest("tr");
    if (!row) {
      return;
    }
    const userId = Number(row.dataset.userId);
    toggleDetailRow(userId);
    const detailRow = elements.tbody.querySelector(
      `.user-details[data-user-id="${userId}"]`
    );
    if (!detailRow.hidden) {
      const user = appState.users.find((entry) => entry.id === userId);
      if (user) {
        populateDetailRow(detailRow, user);
      }
    }
    detailButton.textContent = detailRow && !detailRow.hidden ? "Hide Details" : "Details";
    detailButton.setAttribute(
      "aria-expanded",
      detailRow && !detailRow.hidden ? "true" : "false"
    );
    return;
  }
});

elements.tbody.addEventListener("submit", async (event) => {
  if (!event.target.classList.contains("receipt-upload")) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const form = event.target;
  const detailRow = form.closest("tr.user-details");
  let userId = detailRow ? Number(detailRow.dataset.userId) : null;
  if (!detailRow) {
    userId = selectedAbonoUserId;
  }

  if (!userId) {
    return;
  }

  const fileInput = form.querySelector(".receipt-file");
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    return;
  }

  const file = fileInput.files[0];
  const submitButton = form.querySelector("button[type='submit']");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Uploading...";
  }

  await uploadReceipt(userId, file);
  fileInput.value = "";

  if (submitButton) {
    submitButton.disabled = false;
    submitButton.textContent = "Upload";
  }
});

if (elements.away.select) {
  elements.away.select.addEventListener("change", (event) => {
    const value = Number(event.target.value);
    selectedAwayUserId = Number.isFinite(value) && value > 0 ? value : null;
    renderAwayManager();
    renderAbonoPanel();
  });
}

if (elements.away.addForm) {
  elements.away.addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = getAwayUser();
    if (!user) {
      return;
    }

    const start = elements.away.startInput?.value || "";
    const end = elements.away.endInput?.value || "";
    if (!start || !end) {
      return;
    }

    await createAwayRecord({ userId: user.id, start, end });
    elements.away.addForm.reset();
  });
}

if (elements.away.tableBody) {
  elements.away.tableBody.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }

    if (!target.classList.contains("out-start") && !target.classList.contains("out-end")) {
      return;
    }

    const row = target.closest("tr");
    if (!row) {
      return;
    }

    const payload = {
      start: row.querySelector(".out-start")?.value || null,
      end: row.querySelector(".out-end")?.value || null,
    };

    await updateAwayRecord(Number(row.dataset.recordId), payload);
  });

  elements.away.tableBody.addEventListener("click", async (event) => {
    if (!event.target.classList.contains("delete-away")) {
      return;
    }
    const row = event.target.closest("tr");
    if (!row) {
      return;
    }
    await deleteAwayRecord(Number(row.dataset.recordId));
  });
}

if (elements.abono.select) {
  elements.abono.select.addEventListener("change", (event) => {
    const value = Number(event.target.value);
    selectedAbonoUserId = Number.isFinite(value) && value > 0 ? value : null;
    renderAbonoPanel();
  });
}

if (elements.abono.creditForm) {
  elements.abono.creditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = getAbonoUser();
    if (!user) {
      return;
    }

    const amount = parseAmount(elements.abono.creditInput?.value ?? "");
    const submitButton = elements.abono.creditForm.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";
    }
    await updateAbonoCredit(user.id, amount);
    if (elements.abono.creditInput) {
      elements.abono.creditInput.value = "";
    }
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Save Abono";
    }
  });
}

if (elements.abono.mineralForm) {
  elements.abono.mineralForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = getAbonoUser();
    if (!user) {
      return;
    }

    const amount = parseAmount(elements.abono.mineralInput?.value ?? "");
    const submitButton = elements.abono.mineralForm.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";
    }
    await updateAbonoCredit(user.id, { mineral: true, amount });
    if (elements.abono.mineralInput) {
      elements.abono.mineralInput.value = "";
    }
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Save Mineral Abono";
    }
  });
}

if (elements.abono.uploadForm) {
  elements.abono.uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const user = getAbonoUser();
    if (!user) {
      return;
    }

    const fileInput = elements.abono.uploadInput;
    if (!fileInput || !fileInput.files || !fileInput.files.length) {
      return;
    }

    const submitButton = elements.abono.uploadForm.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Uploading...";
    }

    await uploadReceipt(user.id, fileInput.files[0]);
    fileInput.value = "";

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Upload";
    }
  });
}

if (elements.abono.receiptList) {
  elements.abono.receiptList.addEventListener("click", async (event) => {
    const button = event.target.closest(".receipt-delete");
    if (!button) {
      return;
    }

    const user = getAbonoUser();
    if (!user) {
      return;
    }

    const receiptId = Number(button.dataset.receiptId);
    if (!Number.isFinite(receiptId)) {
      return;
    }

    button.disabled = true;
    button.textContent = "Deleting...";
    await deleteReceipt(user.id, receiptId);
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = "Delete";
    }
  });
}

if (elements.fixed.form) {
  elements.fixed.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sessionState.account?.role !== "admin") {
      return;
    }

    const name = elements.fixed.nameInput?.value.trim();
    const category = elements.fixed.categoryInput?.value;
    const amount = parseAmount(elements.fixed.amountInput?.value ?? "0");

    if (!name || !category) {
      return;
    }

    const submitButton = elements.fixed.form.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Adding...";
    }

    await createFixedItem({ name, category, amount });

    if (elements.fixed.nameInput) {
      elements.fixed.nameInput.value = "";
    }
    if (elements.fixed.categoryInput) {
      elements.fixed.categoryInput.value = "";
    }
    if (elements.fixed.amountInput) {
      elements.fixed.amountInput.value = "";
    }

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Add Fixed Item";
    }
  });
}

if (elements.fixed.tableBody) {
  elements.fixed.tableBody.addEventListener("click", async (event) => {
    if (sessionState.account?.role !== "admin") {
      return;
    }
    const saveButton = event.target.closest(".fixed-save");
    const deleteButton = event.target.closest(".fixed-delete");
    const row = event.target.closest("tr[data-fixed-id]");
    if (!row) {
      return;
    }
    const id = Number(row.dataset.fixedId);
    if (!Number.isFinite(id)) {
      return;
    }

    if (saveButton) {
      const nameInput = row.querySelector(".fixed-name-input");
      const categorySelect = row.querySelector(".fixed-category-select");
      const amountInput = row.querySelector(".fixed-amount-input");

      const name = nameInput?.value.trim();
      const category = categorySelect?.value;
      const amount = parseAmount(amountInput?.value ?? "0");

      if (!name || !category) {
        return;
      }

      saveButton.disabled = true;
      saveButton.textContent = "Saving...";
      await updateFixedItem(id, { name, category, amount });
      if (saveButton.isConnected) {
        saveButton.disabled = false;
        saveButton.textContent = "Save";
      }
    }

    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.textContent = "Deleting...";
      await deleteFixedItem(id);
      if (deleteButton.isConnected) {
        deleteButton.disabled = false;
        deleteButton.textContent = "Delete";
      }
    }
  });
}

if (elements.workspace.form) {
  elements.workspace.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sessionState.account?.role !== "admin") {
      return;
    }
    setWorkspaceFeedback("");
    const input = elements.workspace.nameInput;
    const name = input?.value.trim() || "";
    if (!name) {
      setWorkspaceFeedback("Dorm name is required.", { error: true });
      if (input) {
        input.focus();
      }
      return;
    }
    const submitButton = elements.workspace.form.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";
    }
    try {
      await updateWorkspaceName(name);
      setWorkspaceFeedback("Dorm name saved.");
    } catch (error) {
      console.error("Failed to update workspace name:", error);
      setWorkspaceFeedback(error.message || "Unable to update dorm name.", { error: true });
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Save Name";
      }
    }
  });
}

if (elements.billing.form) {
  elements.billing.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sessionState.account?.role !== "admin") {
      return;
    }
    const start = elements.billing.startInput?.value;
    const end = elements.billing.endInput?.value;
    if (!start || !end) {
      return;
    }

    const submitButton = elements.billing.form.querySelector("button[type='submit']");
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Saving...";
    }

    try {
      await request("/api/billing-period", {
        method: "PATCH",
        body: JSON.stringify({ start, end }),
      });
      await loadState();
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Save Period";
      }
    }
  });
}

if (elements.billing.currentBtn) {
  elements.billing.currentBtn.addEventListener("click", async () => {
    if (sessionState.account?.role !== "admin") {
      return;
    }
    const button = elements.billing.currentBtn;
    button.disabled = true;
    button.textContent = "Setting...";
    try {
      await request("/api/billing-period", {
        method: "PATCH",
        body: JSON.stringify({ use_current: true }),
      });
      await loadState();
    } finally {
      button.disabled = false;
      button.textContent = "Current Period";
    }
  });
}


let expensesUpdateTimer = null;

const scheduleExpenseSync = () => {
  if (!elements.adminForm) {
    return;
  }

  if (sessionState.account?.role !== "admin") {
    return;
  }

  if (expensesUpdateTimer) {
    clearTimeout(expensesUpdateTimer);
  }

  expensesUpdateTimer = setTimeout(() => {
    expensesUpdateTimer = null;
    const payload = {};
    expenseFields.forEach((field) => {
      const input = elements.adminForm.elements.namedItem(field);
      if (input) {
        payload[field] = parseAmount(input.value);
      }
    });
    const rentInput = elements.adminForm.elements.namedItem("rent");
    if (rentInput) {
      payload.rent = parseAmount(rentInput.value);
    }
    updateExpenses(payload);
  }, 300);
};

if (elements.adminForm) {
  elements.adminForm.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement)) {
      return;
    }
    if (sessionState.account?.role !== "admin") {
      return;
    }
    scheduleExpenseSync();
  });
}

const activateTab = (button) => {
  if (button.classList.contains("active")) {
    return;
  }
  elements.tabButtons.forEach((tabButton) => {
    const isActive = tabButton === button;
    tabButton.classList.toggle("active", isActive);
    tabButton.setAttribute("aria-selected", String(isActive));
  });
  const targetPanelId = button.getAttribute("aria-controls");
  elements.tabPanels.forEach((panel) => {
    const isTarget = panel.id === targetPanelId;
    panel.hidden = !isTarget;
  });
};

elements.tabButtons.forEach((button) => {
  button.addEventListener("click", () => activateTab(button));
});

const registerSuperTab = (button, tabId) => {
  if (!button) {
    return;
  }
  button.addEventListener("click", () => {
    if (currentSuperTab === tabId) {
      return;
    }
    setSuperTab(tabId);
    if (tabId === "feedbacks") {
      renderSuperFeedbacks();
    }
  });
};

registerSuperTab(elements.superAdmin.tabs.overview, "overview");
registerSuperTab(elements.superAdmin.tabs.feedbacks, "feedbacks");

if (elements.feedbackWidget.toggle) {
  elements.feedbackWidget.toggle.addEventListener("click", () => {
    if (feedbackState.busy) {
      return;
    }
    toggleFeedbackPanel();
  });
}

if (elements.feedbackWidget.close) {
  elements.feedbackWidget.close.addEventListener("click", () => {
    if (!feedbackState.busy) {
      toggleFeedbackPanel(false);
    }
  });
}

if (elements.feedbackWidget.form) {
  elements.feedbackWidget.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!feedbackState.busy) {
      submitFeedback();
    }
  });
}

if (elements.feedbackWidget.messageInput) {
  elements.feedbackWidget.messageInput.addEventListener("input", () => {
    updateFeedbackCounter();
    setFeedbackStatus("");
  });
}

document.addEventListener("click", (event) => {
  if (!feedbackState.open) {
    return;
  }
  const { panel, toggle } = elements.feedbackWidget;
  if (!panel || !toggle) {
    return;
  }
  if (panel.contains(event.target) || toggle.contains(event.target)) {
    return;
  }
  if (!feedbackState.busy) {
    toggleFeedbackPanel(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && feedbackState.open && !feedbackState.busy) {
    toggleFeedbackPanel(false);
  }
});

const syncAdminForm = () => {
  if (!elements.adminForm) {
    return;
  }
  expenseFields.forEach((field) => {
    const input = elements.adminForm.elements.namedItem(field);
    if (input) {
      const amount = Number(appState.expenses[field] ?? 0);
      input.value = amount ? String(amount) : "";
    }
  });
  const rentInput = elements.adminForm.elements.namedItem("rent");
  if (rentInput) {
    const rentAmount = Number(appState.expenses.rent ?? 0);
    rentInput.value = rentAmount ? String(rentAmount) : "";
  }
};

const initializeApp = async () => {
  const params = new URLSearchParams(window.location.search);
  const inviteParam = params.get("invite");
  let authenticated = false;

  if (inviteParam) {
    inviteTokenFromQuery = inviteParam;
    if (elements.auth.inputs.renterToken) {
      elements.auth.inputs.renterToken.value = inviteParam;
    }
    currentAuthView = "register-renter";
    window.history.replaceState({}, document.title, window.location.pathname);
    await logout();
    authenticated = sessionState.authenticated;
  } else {
    authenticated = await refreshSession();
  }

  if (!currentAuthView) {
    currentAuthView = inviteTokenFromQuery ? "register-renter" : "menu";
  }

  if (authenticated) {
    if (sessionState.account?.role === "superadmin") {
      await loadSuperState();
    } else {
      await loadState();
    }
  } else if (inviteTokenFromQuery) {
    setAuthView("register-renter", { preserveValues: true });
    if (elements.auth.inputs.renterToken) {
      elements.auth.inputs.renterToken.value = inviteTokenFromQuery;
    }
  } else {
    setAuthView("menu", { skipFocus: true });
  }
};

updateFeedbackCounter();
updateFeedbackWidgetVisibility();

initializeApp();
