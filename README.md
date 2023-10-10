# Smart-Boiler
        
        this node belongs to a suite of nodes to control heating made by multiple intelligent Valve and a Central Boiler.
        The scheduling is done by Smart-Scheduler where multiple schedule and set-point can be defined,
        The valve management is done by Smart-Valve where multiple valve can be grouped in one room or group of room. 
        And finally Smart-Boiler aims to control the boiler and to determine the right temperature and set point seeting according to the multiple valves.
        
        <b>Smart-Boiler</b>
        Received input from Smart-Valves and expect message as :
        msg.payload with:
        - sp for setpoint, int value
        - temp for current valve temperature, int value,
        - name for valve description, string value,
        - id for unique valve identification, int value

        ex input message:
        msg.payload={ sp:23,temp:20,name:"Valve kitchen", id:1}

        Each input received will either create a new entry in the valves stack or update the current entry in the stack.

        Smart-Boiler will determined the active valve to be sent to the Boiler, the active valve is determine by valve set point (target temperature) > valve current temperature 
        and by the highest gap between set point and current temperature.

        Exemple : 
        - Valve A : set point 19°C, current temperature 21 °C => inactive
        - Valve B : set point 23°C, current temperature 20 °C, gap is 3 °C => active but not sent to boiler,
        - Valve C : set point is 24°C and current temperature is 19°C, gap is 5°C => active and sent to the boiler.
        
        Additionnal functionnal rules:
        
        - If no active valve is found then highest sp of inactive valve is set as a reference to the boiler. 
        - If no input after max duration (defined in setting), security message is sent to the boiler to avoid endless heating,
        
        Output: 
        - Can be directly to MQTT (preferred);
        - regular output: 

        msg.payload={ sp:23,temp:20,name:"Valve kitchen", id:1, lastTsUpdate: ISOTIME};

        Configuration settings: 

        MQTT: configuration node to define mqtt server connexion
        MQTT updates: when checked, update messages are directly sent to the defined topics
        Output updates: when checked, update messages are sent to the regular output,
        Set point topic: MQTT set Boiler set point topic
        Temperature topic: MQTT set Boiler current temperature topic
        Leading Device topic: MQTT Boiler text topic to indicate which valves is driving the heating
        Update cycle duration: valve stack evaluation duration cycle
        Max Duration since last input: maximum duration before sending security message to the boiler with default values
        Default temp: security message is sent with default temp
        Default set point: security message is sent with default set point

## Run locally


