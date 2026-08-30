window.graveStatusChart = null;
window.monthlyExpirationChart = null;

window.initDashboardCharts = function () {
    const pieCanvas = document.getElementById('graveStatusChart');
    if (pieCanvas) {
        const ctxPie = pieCanvas.getContext('2d');
        window.graveStatusChart = new Chart(ctxPie, {
            type: 'pie',
            data: {
                labels: ['Vacant', 'Occupied', 'Expiring', 'Expired', 'Reserved'],
                datasets: [{
                    data: [312, 1245, 48, 23, 85],
                    backgroundColor: ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6'],
                    borderWidth: 1,
                    hoverOffset: 15
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: 20 },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, usePointStyle: true, pointStyle: 'circle' }
                    }
                }
            }
        });
    }

    const barCanvas = document.getElementById('monthlyExpirationChart');
    if (barCanvas) {
        const ctxBar = barCanvas.getContext('2d');
        const barGradient = ctxBar.createLinearGradient(0, 0, 0, 320);
        barGradient.addColorStop(0, '#6366F1');
        barGradient.addColorStop(1, '#A5B4FC');

        window.monthlyExpirationChart = new Chart(ctxBar, {
            type: 'bar',
            data: {
                labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
                datasets: [{
                    label: 'Expirations',
                    data: [12, 19, 8, 15, 22, 14, 10, 18, 9, 11, 16, 20],
                    backgroundColor: barGradient,
                    borderRadius: 6,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 12 } } },
                    y: { grid: { color: '#F3F4F6' }, beginAtZero: true, ticks: { stepSize: 5 } }
                }
            }
        });
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.initDashboardCharts);
} else {
    window.initDashboardCharts();
}