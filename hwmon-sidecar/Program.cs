using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LibreHardwareMonitor.Hardware;

namespace NexusHwMon;

public sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);

    public void VisitHardware(IHardware hardware)
    {
        try
        {
            hardware.Update();
            foreach (var subHardware in hardware.SubHardware)
            {
                subHardware.Accept(this);
            }
        }
        catch
        {
            // Игнорируем сбои отдельных защищенных датчиков
        }
    }

    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}

public sealed class CoreTempDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("temp_c")]
    public float TempC { get; set; }
}

public sealed class CpuTelemetryDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "Процессор";

    [JsonPropertyName("package_temp_c")]
    public float? PackageTempC { get; set; }

    [JsonPropertyName("max_core_temp_c")]
    public float? MaxCoreTempC { get; set; }

    [JsonPropertyName("avg_clock_mhz")]
    public float? AvgClockMhz { get; set; }

    [JsonPropertyName("power_watts")]
    public float? PowerWatts { get; set; }

    [JsonPropertyName("voltage_v")]
    public float? VoltageV { get; set; }

    [JsonPropertyName("core_temps")]
    public List<CoreTempDto> CoreTemps { get; set; } = new();
}

public sealed class GpuTelemetryDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "Видеокарта";

    [JsonPropertyName("core_temp_c")]
    public float? CoreTempC { get; set; }

    [JsonPropertyName("hotspot_temp_c")]
    public float? HotspotTempC { get; set; }

    [JsonPropertyName("memory_temp_c")]
    public float? MemoryTempC { get; set; }

    [JsonPropertyName("core_clock_mhz")]
    public float? CoreClockMhz { get; set; }

    [JsonPropertyName("memory_clock_mhz")]
    public float? MemoryClockMhz { get; set; }

    [JsonPropertyName("fan_rpm")]
    public float? FanRpm { get; set; }

    [JsonPropertyName("fan_percent")]
    public float? FanPercent { get; set; }

    [JsonPropertyName("power_watts")]
    public float? PowerWatts { get; set; }

    [JsonPropertyName("voltage_v")]
    public float? VoltageV { get; set; }

    [JsonPropertyName("load_percent")]
    public float? LoadPercent { get; set; }
}

public sealed class FanSensorDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("rpm")]
    public float Rpm { get; set; }

    [JsonPropertyName("percent")]
    public float? Percent { get; set; }
}

public sealed class TempSensorDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("temp_c")]
    public float TempC { get; set; }
}

public sealed class StorageTempDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("temp_c")]
    public float? TempC { get; set; }

    [JsonPropertyName("used_percent")]
    public float? UsedPercent { get; set; }
}

public sealed class HardwareTelemetryDto
{
    [JsonPropertyName("is_admin")]
    public bool IsAdmin { get; set; }

    [JsonPropertyName("sidecar_online")]
    public bool SidecarOnline { get; set; } = true;

    [JsonPropertyName("timestamp_ms")]
    public long TimestampMs { get; set; }

    [JsonPropertyName("cpu")]
    public CpuTelemetryDto Cpu { get; set; } = new();

    [JsonPropertyName("gpus")]
    public List<GpuTelemetryDto> Gpus { get; set; } = new();

    [JsonPropertyName("motherboard_name")]
    public string MotherboardName { get; set; } = "Системная плата";

    [JsonPropertyName("motherboard_temps")]
    public List<TempSensorDto> MotherboardTemps { get; set; } = new();

    [JsonPropertyName("system_fans")]
    public List<FanSensorDto> SystemFans { get; set; } = new();

    [JsonPropertyName("storage_temps")]
    public List<StorageTempDto> StorageTemps { get; set; } = new();
}

internal static class Program
{
    private static volatile bool _shouldExit;

    private static bool CheckIsAdmin()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    private static IEnumerable<ISensor> GetAllSensorsRecursive(IHardware hw)
    {
        foreach (var s in hw.Sensors)
        {
            yield return s;
        }
        foreach (var sub in hw.SubHardware)
        {
            foreach (var s in GetAllSensorsRecursive(sub))
            {
                yield return s;
            }
        }
    }

    private static bool IsValidTemp(float? val) =>
        val.HasValue && !float.IsNaN(val.Value) && val.Value > 0f && val.Value < 130f;

    private static bool IsValidPositive(float? val) =>
        val.HasValue && !float.IsNaN(val.Value) && val.Value >= 0f;

    public static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        bool isAdmin = CheckIsAdmin();

        // Отслеживание закрытия родительского процесса через закрытие потока stdin или Ctrl+C
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            _shouldExit = true;
        };

        _ = Task.Run(async () =>
        {
            try
            {
                while (await Console.In.ReadLineAsync() is not null)
                {
                    // Если родительский процесс жив и держит пайп открытым — ждём
                }
            }
            catch
            {
                // Поток ввода закрыт
            }
            _shouldExit = true;
        });

        var computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMotherboardEnabled = true,
            IsMemoryEnabled = true,
            IsStorageEnabled = true,
            IsControllerEnabled = true
        };

        try
        {
            computer.Open();
        }
        catch
        {
            // Продолжаем работу с доступными датчиками даже при частичной ошибке драйвера
        }

        var visitor = new UpdateVisitor();
        var jsonOptions = new JsonSerializerOptions
        {
            WriteIndented = false
        };

        while (!_shouldExit)
        {
            try
            {
                computer.Accept(visitor);
                var snapshot = BuildSnapshot(computer, isAdmin);
                string json = JsonSerializer.Serialize(snapshot, jsonOptions);
                Console.WriteLine(json);
                Console.Out.Flush();
            }
            catch
            {
                // Не прерываем цикл при единичной ошибке чтения
            }

            Thread.Sleep(1000);
        }

        try
        {
            computer.Close();
        }
        catch
        {
            // Игнорируем ошибки закрытия при выходе
        }
    }

    private static HardwareTelemetryDto BuildSnapshot(Computer computer, bool isAdmin)
    {
        var dto = new HardwareTelemetryDto
        {
            IsAdmin = isAdmin,
            SidecarOnline = true,
            TimestampMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };

        foreach (var hw in computer.Hardware)
        {
            switch (hw.HardwareType)
            {
                case HardwareType.Cpu:
                {
                    dto.Cpu.Name = hw.Name;
                    var clockValues = new List<float>();

                    foreach (var s in GetAllSensorsRecursive(hw))
                    {
                        string sName = s.Name ?? "";
                        string sLower = sName.ToLowerInvariant();

                        if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
                        {
                            if (sLower.Contains("distance")) continue;

                            float t = s.Value!.Value;
                            if (sLower.Contains("package") || sLower.Contains("tctl") || sLower.Contains("tdie") || sLower.Contains("average"))
                            {
                                dto.Cpu.PackageTempC = t;
                            }
                            else if (sLower.Contains("core") || sLower.Contains("ccd"))
                            {
                                dto.Cpu.CoreTemps.Add(new CoreTempDto
                                {
                                    Name = sName,
                                    TempC = t
                                });
                                if (!dto.Cpu.MaxCoreTempC.HasValue || t > dto.Cpu.MaxCoreTempC.Value)
                                {
                                    dto.Cpu.MaxCoreTempC = t;
                                }
                            }
                            else if (!dto.Cpu.PackageTempC.HasValue)
                            {
                                dto.Cpu.PackageTempC = t;
                            }
                        }
                        else if (s.SensorType == SensorType.Clock && IsValidPositive(s.Value))
                        {
                            if (!sLower.Contains("bus") && s.Value!.Value > 100f)
                            {
                                clockValues.Add(s.Value.Value);
                            }
                        }
                        else if (s.SensorType == SensorType.Power && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("package") || sLower.Contains("total") || !dto.Cpu.PowerWatts.HasValue)
                            {
                                dto.Cpu.PowerWatts = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Voltage && IsValidPositive(s.Value))
                        {
                            if ((sLower.Contains("core") || sLower.Contains("vid") || !dto.Cpu.VoltageV.HasValue) && s.Value!.Value > 0.2f && s.Value.Value < 2.5f)
                            {
                                dto.Cpu.VoltageV = s.Value.Value;
                            }
                        }
                    }

                    if (!dto.Cpu.PackageTempC.HasValue && dto.Cpu.MaxCoreTempC.HasValue)
                    {
                        dto.Cpu.PackageTempC = dto.Cpu.MaxCoreTempC;
                    }
                    if (!dto.Cpu.MaxCoreTempC.HasValue && dto.Cpu.PackageTempC.HasValue)
                    {
                        dto.Cpu.MaxCoreTempC = dto.Cpu.PackageTempC;
                    }
                    if (clockValues.Count > 0)
                    {
                        dto.Cpu.AvgClockMhz = clockValues.Average();
                    }
                    break;
                }

                case HardwareType.GpuNvidia:
                case HardwareType.GpuAmd:
                case HardwareType.GpuIntel:
                {
                    var gpu = new GpuTelemetryDto
                    {
                        Name = hw.Name
                    };

                    foreach (var s in GetAllSensorsRecursive(hw))
                    {
                        string sName = s.Name ?? "";
                        string sLower = sName.ToLowerInvariant();

                        if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
                        {
                            float t = s.Value!.Value;
                            if (sLower.Contains("hot spot") || sLower.Contains("hotspot") || sLower.Contains("junction"))
                            {
                                gpu.HotspotTempC = t;
                            }
                            else if (sLower.Contains("memory") || sLower.Contains("vram") || sLower.Contains("mem"))
                            {
                                gpu.MemoryTempC = t;
                            }
                            else if (sLower.Contains("core") || !gpu.CoreTempC.HasValue)
                            {
                                gpu.CoreTempC = t;
                            }
                        }
                        else if (s.SensorType == SensorType.Clock && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("core"))
                            {
                                gpu.CoreClockMhz = s.Value!.Value;
                            }
                            else if (sLower.Contains("memory"))
                            {
                                gpu.MemoryClockMhz = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Fan && IsValidPositive(s.Value))
                        {
                            if (!gpu.FanRpm.HasValue || s.Value!.Value > gpu.FanRpm.Value)
                            {
                                gpu.FanRpm = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Control && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("fan") && (!gpu.FanPercent.HasValue || s.Value!.Value > gpu.FanPercent.Value))
                            {
                                gpu.FanPercent = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Power && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("package") || sLower.Contains("total") || sLower.Contains("gpu") || !gpu.PowerWatts.HasValue)
                            {
                                gpu.PowerWatts = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Load && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("core") || sLower.Contains("gpu") || sLower == "3d" || !gpu.LoadPercent.HasValue)
                            {
                                gpu.LoadPercent = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Voltage && IsValidPositive(s.Value))
                        {
                            if (s.Value!.Value > 0.1f && (!gpu.VoltageV.HasValue || sLower.Contains("core")))
                            {
                                gpu.VoltageV = s.Value.Value;
                            }
                        }
                    }

                    dto.Gpus.Add(gpu);
                    break;
                }

                case HardwareType.Motherboard:
                case HardwareType.SuperIO:
                case HardwareType.Cooler:
                case HardwareType.EmbeddedController:
                {
                    if (hw.HardwareType == HardwareType.Motherboard && !string.IsNullOrWhiteSpace(hw.Name))
                    {
                        dto.MotherboardName = hw.Name;
                    }

                    foreach (var s in GetAllSensorsRecursive(hw))
                    {
                        string sName = s.Name ?? "Датчик";
                        if (s.SensorType == SensorType.Fan && IsValidPositive(s.Value))
                        {
                            dto.SystemFans.Add(new FanSensorDto
                            {
                                Name = sName,
                                Rpm = s.Value!.Value
                            });
                        }
                        else if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
                        {
                            dto.MotherboardTemps.Add(new TempSensorDto
                            {
                                Name = sName,
                                TempC = s.Value!.Value
                            });
                        }
                    }
                    break;
                }

                case HardwareType.Storage:
                {
                    var st = new StorageTempDto
                    {
                        Name = hw.Name
                    };

                    foreach (var s in GetAllSensorsRecursive(hw))
                    {
                        string sLower = (s.Name ?? "").ToLowerInvariant();
                        if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
                        {
                            if (!st.TempC.HasValue || sLower.Contains("composite") || sLower.Contains("temperature"))
                            {
                                st.TempC = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Load && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("used"))
                            {
                                st.UsedPercent = s.Value!.Value;
                            }
                        }
                    }

                    dto.StorageTemps.Add(st);
                    break;
                }
            }
        }

        return dto;
    }
}
