import {
    collection,
    doc,
    getDoc,
    getDocs,
    limit,
    query,
    serverTimestamp,
    setDoc,
    where
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";

export const DEFAULT_COMPANY_ID = "akso-company";
export const DEFAULT_CLASS_ID = "akso-default-class";
export const DEFAULT_COMPANY_NAME = "阿克索公司";
export const DEFAULT_CLASS_NAME = "預設減重班";

function normalizeText(value) {
    return String(value || "").trim();
}

function normalizeLower(value) {
    return normalizeText(value).toLowerCase();
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function normalizeRole(roleValue, adminFallback = false) {
    const role = normalizeLower(roleValue);
    if (role === "super_admin" || role === "super-admin") return "super_admin";
    if (role === "admin") return "admin";
    if (role === "coach" || role === "class_admin" || role === "class-admin") return "coach";
    if (role === "student" || role === "customer") return "student";
    return adminFallback ? "admin" : "student";
}

function buildDisplayName(profile, fallbackUser) {
    return (
        normalizeText(profile.姓名) ||
        normalizeText(profile.displayName) ||
        normalizeText(profile.username) ||
        normalizeText(fallbackUser?.displayName) ||
        normalizeText(fallbackUser?.email).split("@")[0] ||
        "使用者"
    );
}

function normalizeClassIds(profile) {
    const raw = Array.isArray(profile.classIds)
        ? profile.classIds
        : [profile.classId, profile.primaryClassId];
    return unique(raw.map(normalizeText)).filter(Boolean);
}

export async function ensureDefaultOrgStructure(db) {
    const companyRef = doc(db, "companies", DEFAULT_COMPANY_ID);
    const classRef = doc(db, "classes", DEFAULT_CLASS_ID);

    await setDoc(companyRef, {
        name: DEFAULT_COMPANY_NAME,
        code: "AKSO",
        status: "active",
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp()
    }, { merge: true });

    await setDoc(classRef, {
        companyId: DEFAULT_COMPANY_ID,
        name: DEFAULT_CLASS_NAME,
        status: "active",
        coachIds: [],
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp()
    }, { merge: true });

    return {
        companyId: DEFAULT_COMPANY_ID,
        classId: DEFAULT_CLASS_ID
    };
}

async function fetchUserDocByUid(db, uid) {
    const directDoc = await getDoc(doc(db, "users", uid));
    if (directDoc.exists()) {
        return { id: directDoc.id, data: directDoc.data() };
    }

    const snapshot = await getDocs(query(collection(db, "users"), where("uid", "==", uid), limit(1)));
    if (!snapshot.empty) {
        const match = snapshot.docs[0];
        return { id: match.id, data: match.data() };
    }
    return null;
}

async function fetchUserDocByField(db, field, value) {
    const normalized = field === "email" ? normalizeLower(value) : normalizeLower(value);
    if (!normalized) return null;
    const snapshot = await getDocs(query(collection(db, "users"), where(field, "==", normalized), limit(1)));
    if (snapshot.empty) return null;
    const match = snapshot.docs[0];
    return { id: match.id, data: match.data() };
}

export async function resolveUserContext(db, authUser, options = {}) {
    const savedUsername = normalizeLower(options.savedUsername || "");
    const fallbackEmail = normalizeLower(authUser?.email || "");

    await ensureDefaultOrgStructure(db);

    let userDoc = await fetchUserDocByUid(db, authUser.uid);
    if (!userDoc && fallbackEmail) {
        userDoc = await fetchUserDocByField(db, "email", fallbackEmail);
    }
    if (!userDoc && savedUsername) {
        userDoc = await fetchUserDocByField(db, "username", savedUsername);
    }

    const adminDoc = await getDoc(doc(db, "管理員", authUser.uid));
    const adminData = adminDoc.exists() ? adminDoc.data() || {} : null;

    const profile = {
        uid: authUser.uid,
        email: fallbackEmail,
        ...(userDoc?.data || {}),
        ...(adminData || {})
    };

    const role = normalizeRole(profile.role, !!adminData);
    const classIds = normalizeClassIds(profile);
    const primaryClassId = normalizeText(profile.primaryClassId || profile.classId || classIds[0] || DEFAULT_CLASS_ID);
    const companyId = normalizeText(profile.companyId || DEFAULT_COMPANY_ID);

    return {
        uid: authUser.uid,
        email: fallbackEmail,
        username: normalizeLower(profile.username || savedUsername || fallbackEmail.split("@")[0]),
        role,
        companyId,
        classIds: unique([...classIds, primaryClassId]).filter(Boolean),
        primaryClassId,
        displayName: buildDisplayName(profile, authUser),
        sourceUserDocId: userDoc?.id || authUser.uid,
        rawProfile: profile
    };
}

export async function ensureUserOrgProfile(db, authUser, context, extra = {}) {
    const docId = context.sourceUserDocId || authUser.uid;
    const payload = {
        uid: authUser.uid,
        email: normalizeLower(authUser.email || context.email || ""),
        username: normalizeLower(context.username || ""),
        role: context.role === "student" ? "customer" : context.role,
        companyId: context.companyId || DEFAULT_COMPANY_ID,
        primaryClassId: context.primaryClassId || DEFAULT_CLASS_ID,
        classIds: unique(context.classIds && context.classIds.length ? context.classIds : [context.primaryClassId || DEFAULT_CLASS_ID]),
        updatedAt: serverTimestamp(),
        ...extra
    };
    if (!context.rawProfile?.createdAt) {
        payload.createdAt = serverTimestamp();
    }
    await setDoc(doc(db, "users", docId), payload, { merge: true });
}

export async function listClassesForContext(db, context) {
    await ensureDefaultOrgStructure(db);
    const snapshot = await getDocs(query(collection(db, "classes"), where("companyId", "==", context.companyId)));
    const rows = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data()
    })).filter((row) => row.status !== "deleted");

    if (context.role === "super_admin" || context.role === "admin") {
        return rows.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant"));
    }

    const allowed = new Set(context.classIds || []);
    return rows
        .filter((row) => allowed.has(row.id))
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant"));
}

export async function createClassRecord(db, context, payload) {
    const classId = normalizeText(payload.id || "").replace(/\s+/g, "-").toLowerCase() || `class-${Date.now()}`;
    const classRef = doc(db, "classes", classId);
    await setDoc(classRef, {
        companyId: context.companyId || DEFAULT_COMPANY_ID,
        name: normalizeText(payload.name) || "未命名班級",
        status: normalizeText(payload.status) || "active",
        startDate: normalizeText(payload.startDate),
        endDate: normalizeText(payload.endDate),
        coachIds: unique((payload.coachIds || []).map(normalizeText)),
        createdBy: context.uid,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp()
    }, { merge: true });
    return classId;
}

export function withOrgContext(data, context, overrides = {}) {
    return {
        ...data,
        companyId: overrides.companyId || context.companyId || DEFAULT_COMPANY_ID,
        classId: overrides.classId || context.primaryClassId || DEFAULT_CLASS_ID,
        classIds: unique(overrides.classIds || context.classIds || [context.primaryClassId || DEFAULT_CLASS_ID]),
        updatedAt: serverTimestamp()
    };
}

export function hasOrgContext(data = {}) {
    return Boolean(data.companyId || data.classId || (Array.isArray(data.classIds) && data.classIds.length));
}
