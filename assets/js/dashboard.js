document.addEventListener('DOMContentLoaded', function () {

    const API_URL = 'api/dashboard.php';
    const Skeleton = window.DashboardSkeleton;

    const COLORS = {
        primary: '#6366f1',
        success: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444',
        reserved: '#8b5cf6',
        neutral: '#cbd5e1',
        text: '#334155',
        mutedText: '#94a3b8',
        grid: '#f1f5f9',
    };

    if (window.Chart) {
        Chart.defaults.font.family =
            "'Inter', sans-serif";
        Chart.defaults.font.size = 12;
        Chart.defaults.color = COLORS.text;
        Chart.defaults.animation.duration = 600;
        Chart.defaults.animation.easing = 'easeOutQuart';
    }

    // Empty Helpers
    // Show or hide a "No Data Available"
    function toggleEmptyState(container, isEmpty) {
        if (!container) return null;

        let empty = container.querySelector('.chartEmptyState');
        if (!empty) {
            empty = document.createElement('div');
            empty.className = 'chartEmptyState';
            empty.textContent = 'No Data Available';
            container.appendChild(empty);
        }
        empty.style.display = isEmpty ? 'flex' : 'none';
        return empty;
    }

    // Stat Cards
    function setStatValue(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent =
            (value === null || value === undefined || Number.isNaN(value))
                ? '—'
                : value;
    }

    function applyStats(data) {
        if (!data) return;
        setStatValue('stat_total_interments', data.total_interment_records);
        setStatValue('stat_available_graves', data.available_graves);
        setStatValue('stat_expiring_leases', data.expiring_leases_count);
        setStatValue('stat_unverified_accounts', data.unverified_accounts);
    }

    // Grave Status Distribution (Pie Chart)
    let pieChart = null;

    function buildPieLegend(segments) {
        const ul = document.getElementById('grave_status_legend');
        if (!ul) return;

        if (!segments.length) {
            ul.innerHTML = '';
            return;
        }

        ul.innerHTML = segments.map(seg => {
            return (
                '<li>' +
                '<span class="legendLeft">' +
                '<span class="legendDot" style="background:' + seg.color + '"></span>' +
                '<span class="legendLabel">' + seg.label + '</span>' +
                '</span>' +
                '<span class="legendValue">' + seg.value + '</span>' +
                '</li>'
            );
        }).join('');
    }

    function renderPie(labels, values) {
        const canvas = document.getElementById('grave_status_chart');
        if (!canvas) return;

        const wrap = canvas.closest('.pieCanvasWrap');
        const legend = document.getElementById('grave_status_legend');

        const total = values.reduce((s, v) => s + (Number(v) || 0), 0);
        const hasData = total > 0;

        toggleEmptyState(wrap, !hasData);
        canvas.style.display = hasData ? '' : 'none';
        if (legend) legend.style.display = hasData ? '' : 'none';

        if (!hasData) {
            if (legend) legend.innerHTML = '';
            return;
        }

        const colorFor = {
            'Vacant': COLORS.success,
            'Occupied': COLORS.primary,
            'Expiring': COLORS.warning,
            'Expired': COLORS.danger,
            'Reserved': COLORS.reserved,
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
            pieChart.data.datasets[0].backgroundColor = segments.map(s => s.color);
            pieChart.update();
            return;
        }

        pieChart = new Chart(canvas.getContext('2d'), {
            type: 'pie',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: segments.map(s => s.color),
                    borderColor: '#ffffff',
                    borderWidth: 2,
                    hoverOffset: 8,
                    hoverBorderColor: '#ffffff',
                    hoverBorderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: 4 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#0f172a',
                        titleColor: '#ffffff',
                        bodyColor: '#e2e8f0',
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: true,
                        boxPadding: 4,
                        callbacks: {
                            label: function (ctx) {
                                const v = ctx.parsed || 0;
                                const pct = total > 0
                                    ? ((v / total) * 100).toFixed(1)
                                    : '0.0';
                                return '  ' + ctx.label + ': ' + v + ' (' + pct + '%)';
                            },
                        },
                    },
                },
            },
        });
    }

    // Monthly Lease Expiration (Bar Chart)
    let barChart = null;

    function renderBar(labels, values) {
        const canvas = document.getElementById('monthly_expiration_chart');
        if (!canvas) return;

        const wrap = canvas.closest('.chartWrapper');

        const hasData = values.some(v => Number(v) > 0);

        toggleEmptyState(wrap, !hasData);
        canvas.style.display = hasData ? '' : 'none';

        if (!hasData) {
            return;
        }

        const maxValue = Math.max(0, ...values.map(v => Number(v) || 0));

        const backgroundColors = values.map(v =>
            (Number(v) === maxValue && maxValue > 0)
                ? COLORS.primary
                : 'rgba(99, 102, 241, 0.55)'
        );

        const borderColors = values.map(v =>
            (Number(v) === maxValue && maxValue > 0)
                ? COLORS.primary
                : 'rgba(99, 102, 241, 0.85)'
        );

        if (barChart) {
            barChart.data.labels = labels;
            barChart.data.datasets[0].data = values;
            barChart.data.datasets[0].backgroundColor = backgroundColors;
            barChart.data.datasets[0].borderColor = borderColors;
            barChart.update();
            return;
        }

        barChart = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Expirations',
                    data: values,
                    backgroundColor: backgroundColors,
                    borderColor: borderColors,
                    borderWidth: 1,
                    borderRadius: 6,
                    borderSkipped: false,
                    maxBarThickness: 32,
                    hoverBackgroundColor: COLORS.primary,
                    hoverBorderColor: COLORS.primary,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 8, right: 8, bottom: 0, left: 0 } },
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#0f172a',
                        titleColor: '#ffffff',
                        bodyColor: '#e2e8f0',
                        padding: 10,
                        cornerRadius: 8,
                        displayColors: false,
                        callbacks: {
                            title: items => items[0]?.label || '',
                            label: ctx => '  ' + ctx.parsed.y + ' expiring',
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: {
                            color: COLORS.mutedText,
                            font: { size: 11, weight: '600' },
                            maxRotation: 0,
                            autoSkip: false,
                        },
                    },
                    y: {
                        beginAtZero: true,
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
    }

    function transformGraveDistribution(dist) {
        const order = ['Vacant', 'Occupied', 'Expiring', 'Expired', 'Reserved'];
        const labels = [];
        const values = [];

        order.forEach(key => {
            labels.push(key);
            values.push(Number(dist?.[key] ?? 0) || 0);
        });

        return { labels, values };
    }

    function transformMonthlyExpiration(monthly) {
        if (!monthly || typeof monthly !== 'object') {
            return { labels: [], values: [] };
        }

        const keys = Object.keys(monthly).sort();
        const labels = [];
        const values = [];

        keys.forEach(key => {
            const parts = key.split('-');
            const year = parseInt(parts[0], 10);
            const month = parseInt(parts[1], 10);
            if (Number.isNaN(year) || Number.isNaN(month)) return;

            const d = new Date(year, month - 1, 1);
            labels.push(d.toLocaleString('en-US', { month: 'short' }));
            values.push(Number(monthly[key]) || 0);
        });

        return { labels, values };
    }

    // Render All
    // Apply stats, pie chart, and bar chart using one data object
    function renderAll(data) {
        applyStats(data);

        const pie = transformGraveDistribution(data.grave_status_distribution);
        renderPie(pie.labels, pie.values);

        const bar = transformMonthlyExpiration(data.monthly_lease_expiration);
        renderBar(bar.labels, bar.values);
    }

    // Fetch
    // Load dashboard data from the API, handle loading/errors, then render
    async function loadDashboard(options = {}) {
        const { showLoading = true } = options;

        if (showLoading && Skeleton) Skeleton.show();

        try {
            const res = await fetch(API_URL, {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
            });

            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); }
            catch (_) { throw new Error('Non-JSON response from ' + API_URL); }

            if (!res.ok || (json && json.success === false)) {
                throw new Error(
                    (json && (json.message || json.error)) || ('HTTP ' + res.status)
                );
            }

            const data = (json && json.data) ? json.data : json;

            renderAll(data);
            if (Skeleton) Skeleton.writeCache(data);
            if (Skeleton) Skeleton.consumeInvalidation();

        } catch (err) {
            console.error('[dashboard] load failed:', err);

            setStatValue('stat_total_interments', '—');
            setStatValue('stat_available_graves', '—');
            setStatValue('stat_expiring_leases', '—');
            setStatValue('stat_unverified_accounts', '—');

            renderPie(
                ['Vacant', 'Occupied', 'Expiring', 'Expired', 'Reserved'],
                [0, 0, 0, 0, 0]
            );

            const now = new Date();
            const labels = [];
            const values = [];
            for (let i = 0; i < 12; i++) {
                const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
                labels.push(d.toLocaleString('en-US', { month: 'short' }));
                values.push(0);
            }
            renderBar(labels, values);

        } finally {
            if (Skeleton) Skeleton.hide();
        }
    }

    window.refreshDashboard = function () {
        return loadDashboard({ showLoading: true });
    };

    window.silentRefreshDashboard = function () {
        return loadDashboard({ showLoading: false });
    };

    window.addEventListener('dashboard:invalidated', function () {
        if (!document.querySelector('.dashboardContent')) return;
        loadDashboard({ showLoading: true });
    });

    const cached = Skeleton ? Skeleton.readCache() : null;

    if (cached) {
        renderAll(cached);
    }

    loadDashboard({ showLoading: true });
});