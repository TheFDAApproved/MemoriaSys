(function () {
    if (window.showAlert) return;

    const style = document.createElement("style");

    style.textContent = `
        #customAlertContainer{
            position:fixed;
            top:20px;
            right:20px;
            z-index:999999;
            display:flex;
            flex-direction:column;
            gap:14px;
            pointer-events:none;
            font-family:
                Inter,
                Arial,
                sans-serif;
        }

        .modernAlert{
            min-width:300px;
            max-width:380px;

            padding:16px 18px;
            border-radius:18px;

            color:white;
            font-size:14px;
            font-weight:500;
            line-height:1.5;

            position:relative;
            overflow:hidden;

            pointer-events:auto;

            transform:
                translateX(120%)
                scale(0.95);

            opacity:0;

            transition:
                transform 0.35s ease,
                opacity 0.35s ease;

            box-shadow:
                0 12px 35px rgba(0,0,0,0.18);

            backdrop-filter:blur(10px);

            border:1px solid rgba(255,255,255,0.08);
        }

        .modernAlert.show{
            transform:
                translateX(0)
                scale(1);

            opacity:1;
        }

        .modernAlert.success{
            background:
                linear-gradient(
                    135deg,
                    #16a34a,
                    #22c55e
                );
        }

        .modernAlert.error{
            background:
                linear-gradient(
                    135deg,
                    #dc2626,
                    #ef4444
                );
        }

        .modernAlert.warning{
            background:
                linear-gradient(
                    135deg,
                    #d97706,
                    #f59e0b
                );
        }

        .modernAlert.info{
            background:
                linear-gradient(
                    135deg,
                    #2563eb,
                    #3b82f6
                );
        }

        .modernAlert::before{
            content:"";

            position:absolute;

            top:-40%;
            left:-20%;

            width:160%;
            height:160%;

            background:
                linear-gradient(
                    rgba(255,255,255,0.18),
                    transparent
                );

            transform:rotate(25deg);

            pointer-events:none;
        }

        .modernAlert::after{
            content:"";

            position:absolute;

            bottom:0;
            left:0;

            width:100%;
            height:4px;

            background:
                rgba(255,255,255,0.4);

            animation:
                modernAlertTimer linear forwards;
        }

        @keyframes modernAlertTimer{
            from{
                width:100%;
            }

            to{
                width:0%;
            }
        }

        .modernAlertClose{

            position:absolute;

            top:10px;
            right:14px;

            font-size:18px;
            font-weight:bold;

            cursor:pointer;

            opacity:0.75;

            transition:
                0.2s ease;
        }

        .modernAlertClose:hover{
            opacity:1;
            transform:scale(1.12);
        }

        .modernAlertMessage{
            padding-right:24px;
        }

    `;

    document.head.appendChild(style);

    const container = document.createElement("div");

    container.id = "customAlertContainer";

    document.body.appendChild(container);

    window.showAlertTOP = function (message, type = "info", duration = 4000) {
        const alertBox = document.createElement("div");

        alertBox.className = `modernAlert ${type}`;

        alertBox.innerHTML = `
        
            <div class="modernAlertMessage">
                ${message}
            </div>

            <span class="modernAlertClose">
                &times;
            </span>

        `;

        alertBox.style.setProperty("--duration", duration + "ms");

        alertBox.style.animationDuration = duration + "ms";

        container.appendChild(alertBox);

        requestAnimationFrame(() => {
            alertBox.classList.add("show");
        });

        alertBox.style.setProperty("animation-duration", duration + "ms");

        alertBox.style.setProperty("--alert-duration", duration + "ms");

        alertBox.style.cssText += `
            --alert-duration:${duration}ms;
        `;

        alertBox.querySelector(".modernAlertClose").onclick = removeAlert;

        function removeAlert() {
            alertBox.classList.remove("show");

            setTimeout(() => {
                alertBox.remove();
            }, 350);
        }

        setTimeout(removeAlert, duration);

        const timerStyle = document.createElement("style");

        timerStyle.textContent = `
            .modernAlert::after{
                animation-duration:${duration}ms;
            }
        `;

        document.head.appendChild(timerStyle);
    };
})();

function animateInputsOnError(inputIds) {
    inputIds.forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;

        input.style.transition = "0.3s";
        input.style.borderColor = "red";
        input.style.boxShadow = "0 0 8px red";

        input.animate(
            [
                { transform: "translateX(0)" },
                { transform: "translateX(-5px)" },
                { transform: "translateX(5px)" },
                { transform: "translateX(-5px)" },
                { transform: "translateX(0)" },
            ],
            { duration: 300 },
        );

        setTimeout(() => {
            input.style.borderColor = "";
            input.style.boxShadow = "";
        }, 1950);
    });
}