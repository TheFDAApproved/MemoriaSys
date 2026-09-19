(function () {
    'use strict';

    var LOGIN_PAGE = 'login.html';

    var PUBLIC_PAGES = [
        'login.html',
        'signup.html',
        'forgot_password.html'
    ];

    var ROLE_PAGE = {
        'Administrator': 'admin.html',
        'Grounds Staff': 'grounds.html',
        'Office Staff':   'office.html'
    };

    var PAGE_ROLE = (function () {
        var map = {};
        for (var role in ROLE_PAGE) {
            if (Object.prototype.hasOwnProperty.call(ROLE_PAGE, role)) {
                map[ROLE_PAGE[role].toLowerCase()] = role;
            }
        }
        return map;
    })();

    var current = (location.pathname.split('/').pop() || '').toLowerCase();

    if (!current) current = LOGIN_PAGE;

    if (PUBLIC_PAGES.indexOf(current) !== -1) return;

    var requiredRole = PAGE_ROLE[current] || null; 

    document.documentElement.style.visibility = 'hidden';

    function allow() {
        document.documentElement.style.visibility = '';
    }

    function deny(url) {
        location.replace(url || LOGIN_PAGE);
    }

    fetch('api/auth.php', { credentials: 'same-origin' })
        .then(function (res) {
            if (!res.ok) throw new Error('unauthenticated');
            return res.json();
        })
        .then(function (body) {
            var payload = (body && body.data) ? body.data : body;
            var role = payload && payload.role;

            if (!payload || !role) {
                deny(LOGIN_PAGE);
                return;
            }

            if (requiredRole && role !== requiredRole) {
                deny(ROLE_PAGE[role] || LOGIN_PAGE);
                return;
            }

            allow();
        })
        .catch(function () {
            deny(LOGIN_PAGE);
        });
})();