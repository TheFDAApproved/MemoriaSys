document.addEventListener("DOMContentLoaded", function () {
    const API_URL = "api/dashboard.php";

    // Shared color palette used by both charts
    const COLORS = {
        primary: "#6366f1",
        success: "#10b981",
        warning: "#f59e0b",
        danger: "#ef4444",
        reserved: "#8b5cf6",
        neutral: "#cbd5e1",
        text: "#334155",
        mutedText: "#94a3b8",
        grid: "#f1f5f9",
    };

    if (window.Chart) {
        Chart.defaults.font.family = "'Inter', sans-serif";
        Chart.defaults.font.size = 12;
        Chart.defaults.color = COLORS.text;
        Chart.defaults.animation.duration = 800;
        Chart.defaults.animation.easing = "easeOutQuart";
    }

    // Loading State
    let loadingStartedAt = 0;

    // Adds or removes the is-loading class on the dashboard
    // On hide, waits at least 300ms so the skeleton doesn't flash
    function setLoading(isLoading) {
        const el = document.querySelector(".dashboardContent");
        if (!el) return Promise.resolve();

        if (isLoading) {
            loadingStartedAt = Date.now();
            el.classList.add("is-loading");
            return Promise.resolve();
        }

        if (!el.classList.contains("is-loading")) {
            return Promise.resolve();
        }

        const remaining = Math.max(0, 300 - (Date.now() - loadingStartedAt));
        return new Promise((resolve) => {
            setTimeout(() => {
                el.classList.remove("is-loading");
                resolve();
            }, remaining);
        });
    }

    // Empty State
    // Shows or hides the "No Data Available" label inside a chart
    function toggleEmptyState(container, isEmpty) {
        if (!container) return null;

        let empty = container.querySelector(".chartEmptyState");
        if (!empty) {
            empty = document.createElement("div");
            empty.className = "chartEmptyState";
            empty.textContent = "No Data Available";
            container.appendChild(empty);
        }
        empty.style.display = isEmpty ? "flex" : "none";
        return empty;
    }

    // Small Helpers
    function isPlainObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function hasKey(obj, key) {
        return isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
    }

    // Returns [visible, value] for a top-level key on the payload
    function pickKey(obj, key) {
        if (!hasKey(obj, key)) return { visible: false, value: null };
        return { visible: true, value: obj[key] };
    }

    // Status Card
    function resolvePendingPayments(data) {
        if (
            isPlainObject(data.payments) &&
            hasKey(data.payments, "unconfirmed_count")
        ) {
            const n = Number(data.payments.unconfirmed_count);
            return { visible: true, value: Number.isFinite(n) ? n : 0 };
        }

        if (hasKey(data, "payments_awaiting_my_confirmation")) {
            const n = Number(data.payments_awaiting_my_confirmation);
            return { visible: true, value: Number.isFinite(n) ? n : 0 };
        }

        return { visible: false, value: null };
    }

    const STAT_CARDS = [
        {
            cardId: "total_interments",
            statId: "stat_total_interments",
            resolve: (data) => pickKey(data, "total_interment_records"),
        },
        {
            cardId: "available_graves",
            statId: "stat_available_graves",
            resolve: (data) => pickKey(data, "available_graves"),
        },
        {
            cardId: "expiring_leases",
            statId: "stat_expiring_leases",
            resolve: (data) => pickKey(data, "expiring_leases_count"),
        },
        {
            cardId: "pending_payments",
            statId: "stat_pending_payments",
            resolve: resolvePendingPayments,
        },
        {
            cardId: "unverified_accounts",
            statId: "stat_unverified_accounts",
            resolve: (data) => pickKey(data, "unverified_accounts"),
        },
    ];

    // Writes a value into a stat card
    // Shows a dash for bad values
    function setStatValue(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent =
            value === null || value === undefined || Number.isNaN(value)
                ? "—"
                : value;
    }

    function syncGridLayout(cards) {
        const grid = document.querySelector(".statsGrid");
        if (!grid) return;

        const visible = cards.filter((c) => c && c.style.display !== "none");
        const hidden = cards.filter((c) => c && c.style.display === "none");
        [...visible, ...hidden].forEach((c) => grid.appendChild(c));

        const n = visible.length;
        grid.classList.remove("grid3", "grid4", "grid5");
        if (n <= 3) grid.classList.add("grid3");
        else if (n === 4) grid.classList.add("grid4");
        else grid.classList.add("grid5");
    }

    // Safety net: if data breaks, show all cards with a dash so the grid never ends up empty
    function showAllCardsFallback(reason) {
        const cards = STAT_CARDS.map((cfg) => {
            const card = document.getElementById(cfg.cardId);
            if (!card) return null;
            card.style.display = "";
            setStatValue(cfg.statId, "—");
            return card;
        }).filter(Boolean);

        const grid = document.querySelector(".statsGrid");
        if (grid) {
            cards.forEach((c) => grid.appendChild(c));
            grid.classList.remove("grid3", "grid4", "grid5");
            grid.classList.add("grid5");
        }
    }

    // Fills each stat card from the API data
    // A card with visible:false gets hidden
    function applyStats(data) {
        if (!isPlainObject(data)) {
            showAllCardsFallback("payload was not an object");
            return;
        }

        const cards = [];
        let visibleCount = 0;

        STAT_CARDS.forEach((cfg) => {
            const card = document.getElementById(cfg.cardId);
            if (!card) return;
            cards.push(card);

            let result = { visible: false, value: null };
            try {
                const resolved = cfg.resolve(data);
                if (isPlainObject(resolved)) result = resolved;
            } catch (_) {
                // A throwing resolver just hides that one card
                result = { visible: false, value: null };
            }

            if (result.visible) {
                card.style.display = "";
                setStatValue(cfg.statId, result.value);
                visibleCount++;
            } else {
                card.style.display = "none";
            }
        });

        if (visibleCount === 0) {
            showAllCardsFallback("all cards would be hidden — data may be malformed");
            return;
        }

        syncGridLayout(cards);
    }

    // Pie Chart - Grave Status Distribution
    let pieChart = null;

    // Builds the custom legend list shown under the pie
    function buildPieLegend(segments) {
        const ul = document.getElementById("grave_status_legend");
        if (!ul) return;

        if (!segments.length) {
            ul.innerHTML = "";
            return;
        }

        ul.innerHTML = segments
            .map((seg) => {
                return (
                    "<li>" +
                    '<span class="legendLeft">' +
                    '<span class="legendDot" style="background:' +
                    seg.color +
                    '"></span>' +
                    '<span class="legendLabel">' +
                    seg.label +
                    "</span>" +
                    "</span>" +
                    '<span class="legendValue">' +
                    seg.value +
                    "</span>" +
                    "</li>"
                );
            })
            .join("");
    }

    // Draws or updates the pie
    function renderPie(labels, values, delayMs) {
        const canvas = document.getElementById("grave_status_chart");
        if (!canvas) return;

        const wrap = canvas.closest(".pieCanvasWrap");
        const legend = document.getElementById("grave_status_legend");

        const total = values.reduce((s, v) => s + (Number(v) || 0), 0);
        const hasData = total > 0;

        toggleEmptyState(wrap, !hasData);
        canvas.style.display = hasData ? "" : "none";
        if (legend) legend.style.display = hasData ? "" : "none";

        if (!hasData) {
            if (legend) legend.innerHTML = "";
            return;
        }

        // Maps each status label to a color
        const colorFor = {
            Vacant: COLORS.success,
            Occupied: COLORS.primary,
            Expiring: COLORS.warning,
            Expired: COLORS.danger,
            Reserved: COLORS.reserved,
            Other: COLORS.neutral,
        };

        const segments = labels.map((label, i) => ({
            label,
            value: Number(values[i]) || 0,
            color: colorFor[label] || COLORS.neutral,
        }));

        buildPieLegend(segments);

        if (pieChart) {
            pieChart.data.labels = labels;
            pieChart.data.datasets[0].data = values;
            pieChart.data.datasets[0].backgroundColor = segments.map((s) => s.color);
            pieChart.update();
            return;
        }

        pieChart = new Chart(canvas.getContext("2d"), {
            type: "pie",
            data: {
                labels,
                datasets: [
                    {
                        data: labels.map(() => 0),
                        backgroundColor: segments.map((s) => s.color),
                        borderColor: "#ffffff",
                        borderWidth: 2,
                        hoverOffset: 8,
                        hoverBorderColor: "#ffffff",
                        hoverBorderWidth: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: 4 },

                animation: {
                    animateRotate: true,
                    animateScale: true,
                    duration: 1100,
                    easing: "easeOutQuart",
                },

                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#0f172a",
                        titleColor: "#ffffff",
                        bodyColor: "#e2e8f0",
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: true,
                        boxPadding: 4,
                        callbacks: {
                            label: function (ctx) {
                                const v = ctx.parsed || 0;
                                const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0.0";
                                return "  " + ctx.label + ": " + v + " (" + pct + "%)";
                            },
                        },
                    },
                },
            },
        });

        // Fill real data after the skeleton fades
        setTimeout(() => {
            if (!pieChart) return;
            pieChart.data.datasets[0].data = values;
            pieChart.update();
        }, delayMs || 0);
    }

    // Bar Chart - Monthly Lease Expiration
    let barChart = null;

    // Draws or updates the bar chart
    function renderBar(labels, values, delayMs) {
        const canvas = document.getElementById("monthly_expiration_chart");
        if (!canvas) return;

        const wrap = canvas.closest(".chartWrapper");
        const hasData = values.some((v) => Number(v) > 0);

        toggleEmptyState(wrap, !hasData);
        canvas.style.display = hasData ? "" : "none";

        if (!hasData) return;

        const maxValue = Math.max(0, ...values.map((v) => Number(v) || 0));

        // Fixed Y max so the axis doesn't jump when data appears
        const yMax = Math.max(1, Math.ceil(maxValue * 1.2));

        // Highlight the tallest bar
        const backgroundColors = values.map((v) =>
            Number(v) === maxValue && maxValue > 0
                ? COLORS.primary
                : "rgba(99, 102, 241, 0.55)",
        );

        const borderColors = values.map((v) =>
            Number(v) === maxValue && maxValue > 0
                ? COLORS.primary
                : "rgba(99, 102, 241, 0.85)",
        );

        if (barChart) {
            barChart.data.labels = labels;
            barChart.data.datasets[0].data = values;
            barChart.data.datasets[0].backgroundColor = backgroundColors;
            barChart.data.datasets[0].borderColor = borderColors;
            barChart.options.scales.y.max = yMax;
            barChart.update();
            return;
        }

        barChart = new Chart(canvas.getContext("2d"), {
            type: "bar",
            data: {
                labels,
                datasets: [
                    {
                        label: "Expirations",
                        data: labels.map(() => 0),
                        backgroundColor: backgroundColors,
                        borderColor: borderColors,
                        borderWidth: 1,
                        borderRadius: 6,
                        borderSkipped: false,
                        maxBarThickness: 32,
                        hoverBackgroundColor: COLORS.primary,
                        hoverBorderColor: COLORS.primary,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },

                // Left-to-right wave animation
                animation: {
                    duration: 1100,
                    easing: "easeOutQuart",
                    delay: (context) => {
                        if (context.type === "data" && context.mode === "default") {
                            return context.dataIndex * 70;
                        }
                        return 0;
                    },
                },

                interaction: {
                    mode: "index",
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "#0f172a",
                        titleColor: "#ffffff",
                        bodyColor: "#e2e8f0",
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            title: (items) => items[0]?.label || "",
                            label: (ctx) => "  " + ctx.parsed.y + " expiring",
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: {
                            color: COLORS.mutedText,
                            font: { size: 11, weight: "600" },
                            maxRotation: 0,
                            autoSkip: false,
                        },
                    },
                    y: {
                        beginAtZero: true,
                        max: yMax,
                        ticks: {
                            color: COLORS.mutedText,
                            font: { size: 11 },
                            stepSize: 1,
                            precision: 0,
                            padding: 8,
                        },
                        grid: {
                            color: COLORS.grid,
                            drawTicks: false,
                            drawBorder: false,
                        },
                        border: { display: false },
                    },
                },
            },
        });

        // Fill real data after the skeleton fades
        setTimeout(() => {
            if (!barChart) return;
            barChart.data.datasets[0].data = values;
            barChart.update();
        }, delayMs || 0);
    }

    // Data Transforms
    // Keeps a fixed order for the pie slices.
    function transformGraveDistribution(dist) {
        const order = [
            "Vacant",
            "Occupied",
            "Expiring",
            "Expired",
            "Reserved",
            "Other",
        ];
        const labels = [];
        const values = [];

        order.forEach((key) => {
            labels.push(key);
            values.push(Number(dist?.[key] ?? 0) || 0);
        });

        return { labels, values };
    }

    function transformMonthlyExpiration(monthly) {
        if (!monthly || typeof monthly !== "object") {
            return { labels: [], values: [] };
        }

        const keys = Object.keys(monthly).sort();
        const labels = [];
        const values = [];

        keys.forEach((key) => {
            const parts = key.split("-");
            const year = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10);
            if (Number.isNaN(year) || Number.isNaN(month)) return;

            const d = new Date(year, month - 1, 1);
            labels.push(d.toLocaleString("en-US", { month: "short" }));
            values.push(Number(monthly[key]) || 0);
        });

        return { labels, values };
    }

    // Render Helpers
    // Sends each dataset through its transform then draws it
    function renderCharts(data, options = {}) {
        const { delayMs = 0 } = options;

        const pie = transformGraveDistribution(data.grave_status_distribution);
        renderPie(pie.labels, pie.values, delayMs);

        const bar = transformMonthlyExpiration(data.monthly_lease_expiration);
        renderBar(bar.labels, bar.values, delayMs);
    }

    function renderEmptyCharts() {
        renderPie(
            ["Vacant", "Occupied", "Expiring", "Expired", "Reserved", "Other"],
            [0, 0, 0, 0, 0, 0],
            0,
        );

        const now = new Date();
        const labels = [];
        const values = [];
        for (let i = 0; i < 12; i++) {
            const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
            labels.push(d.toLocaleString("en-US", { month: "short" }));
            values.push(0);
        }
        renderBar(labels, values, 0);
    }

    // Main Load
    async function loadDashboard(options = {}) {
        const { showLoading = true } = options;

        if (showLoading) await setLoading(true);

        try {
            const res = await fetch(API_URL, {
                headers: { Accept: "application/json" },
                credentials: "same-origin",
            });

            const text = await res.text();
            let json = null;
            try {
                json = JSON.parse(text);
            } catch (_) {
                throw new Error("Non-JSON response from " + API_URL);
            }

            if (!res.ok || (json && json.success === false)) {
                throw new Error(
                    (json && (json.message || json.error)) || "HTTP " + res.status,
                );
            }

            const data = json && json.data ? json.data : json;

            applyStats(data);

            if (showLoading) await setLoading(false);

            renderCharts(data, { delayMs: showLoading ? 300 : 0 });
        } catch (err) {
            showAllCardsFallback("fetch/parse error");

            if (showLoading) await setLoading(false);

            renderEmptyCharts();
        }
    }

    // PUBLIC API and EVENTS
    // Manual reload with the skeleton shown
    window.refreshDashboard = function () {
        return loadDashboard({ showLoading: true });
    };

    // Reload without the skeleton [used after small changes]
    window.silentRefreshDashboard = function () {
        return loadDashboard({ showLoading: false });
    };

    // Other scripts can trigger a silent refresh by dispatching this event
    window.addEventListener("dashboard:invalidated", function () {
        if (!document.querySelector(".dashboardContent")) return;
        loadDashboard({ showLoading: false });
    });

    // First page load
    loadDashboard({ showLoading: true });
});